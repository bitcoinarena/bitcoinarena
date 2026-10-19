// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OBJECTION, CHECKED ON ITS OWN EVIDENCE (§13ARULED 2026-10-04: "An objection must carry the
// transcript and the receipts").
//
// "It is valid iff every checkpoint carries genuine receipts, the chain is consistent, and deterministic replay under
// the round's sim_wasm_hash produces claimed_result != signed_result. Anyone can check this; there is no judgement
// involved, only replay."
//
// Until this, POST /objection took no body and an objection held only where the seat's OWN replay already disagreed -
// so two seats that signed a lie together could not be overturned by the player holding the true run and its receipts.
// This is the one check a seat runs on the bundle at its door, and the same function a stranger runs from the command
// line (tools/check-objection.mjs): nothing here reads a store, a clock or a peer. What it is handed - the round's
// contract, committee, entry and signed run, the core and the beacon - is public; the replay is the core's.
//
// THE REFUSALS, IN THIS ORDER, EACH NAMED (the agreement): the signature; the round, entry and result named; the
// transcript's hash; the checkpoint chain; that the transcript belongs to the entry; that every checkpoint has a receipt
// signed by a committee member; the replay under the round's own core gives the claimed result, and it differs from the
// signed one.
import { decodeObjectionBundle, objectionId } from '../../arena-protocol/src/objection.js';
import { decodeTranscript, transcriptHash, checkTranscript, transcriptBelongsToEntry, flatten } from '../../arena-protocol/src/transcript.js';
import { decodeCheckpoint, checkpointId, splitSigned } from '../../arena-protocol/src/checkpoint.js';
import { splitSignedReceipt, decodeCheckpointReceipt, receiptId, SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { resultFrom, runId } from './verdict.js';
import { replay } from './replay.js';
import { dissentsOn } from './test-dissent.js';

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
const NOBODY = new Uint8Array(32);

/** The decoded canonical transcript in the shape `replay` eats: absolute ticks, absolute events (`readTranscript`'s). */
export function replayFormOf(t) {
  const f = flatten(t);
  const at = (rows) => rows.map(([tick, ...rest]) => [tick + f.firstTick, ...rest]);
  return {
    ticks: f.ticks.map((words, i) => ({ tick: f.firstTick + i, words: [...words] })),
    liquidations: at(f.liquidations), loads: at(f.loads), samples: at(f.samples), tapes: at(f.tapes),
  };
}

/** The run's inputs as GET /replay/transcript hands them out (readTranscript's shape), checked for that shape. */
export function inputsFormOf(j) {
  const rows = (x, name) => { if (!Array.isArray(x)) throw new Error(`${name} is not a list`); return x; };
  const ticks = rows(j && j.ticks, 'ticks').map((r, i) => {
    if (!r || !Number.isInteger(r.tick) || !Array.isArray(r.words) || !r.words.every(Number.isInteger)) throw new Error(`tick row ${i} is not { tick, words }`);
    return { tick: r.tick, words: r.words };
  });
  const ints = (x, name) => rows(x || [], name).map((r, i) => {
    if (!Array.isArray(r) || !r.every(Number.isInteger)) throw new Error(`${name} row ${i} is not a list of integers`);
    return r;
  });
  return { ticks, liquidations: ints(j.liquidations, 'liquidations'), loads: ints(j.loads, 'loads'), samples: ints(j.samples, 'samples'), tapes: ints(j.tapes, 'tapes') };
}

/**
 * CHECK ONE OBJECTION BUNDLE. `bundle` the bytes posted; `roundId`, `entryId` the run it is filed against; `entry` that
 * entry's signed contract; `contract` the round's; `committee` its signer nodes' keys; `signedResultId` the run the
 * committee signed (the agreed re-run's, for a second objection); `core` the round's core as the seat resolves it
 * (with its `runTicks` and `world`); `roundRandomness` the round's beacon; `verify(sig, msg, pubkey)` BIP-340.
 * `replayRun(form, entry, options)` defaults to the core's own `replay`; a seat hands its worker pool's, same answer.
 * Returns `{ holds, step, why, ... }` - `step` names the check that refused.
 */
export async function checkObjectionBundle({ bundle, roundId, entryId, entry, contract, committee, signedResultId,
  core, roundRandomness, verify, replayRun = async (form, e, options) => replay(form, e, options) }) {
  const no = (step, why) => ({ holds: false, step, why });
  if (!(bundle instanceof Uint8Array) || !bundle.length)
    return no('bundle', 'an objection carries its transcript and receipts (13A)');
  let b;
  try { b = decodeObjectionBundle(bundle); } catch (e) { return no('bundle', `that is not an objection bundle: ${e.message}`); }
  const o = b.objection;

  // 1. THE SIGNATURE: the objector signs the objection's id; anyone may object, nobody may object in another's name.
  let signed = false;
  try { signed = verify(b.signature, objectionId(o), o.objectorPubkey); } catch { signed = false; }
  if (!signed) return no('signature', `the objector's signature does not verify under ${hex(o.objectorPubkey).slice(0, 16)}`);

  // 2. THE ROUND, ENTRY AND RESULT NAMED: this round, this entry's player, the run the committee signed.
  if (hex(o.roundId) !== hex(roundId)) return no('names', `that objection is about round ${hex(o.roundId).slice(0, 16)}, not this one`);
  if (!entry || hex(entryIdOf(entry)) !== hex(entryId)) return no('names', 'that entry is not the one this objection is filed against');
  if (hex(o.playerPubkey) !== hex(entry.playerPubkey)) return no('names', `that objection names player ${hex(o.playerPubkey).slice(0, 16)}, not this entry's`);
  if (!(signedResultId instanceof Uint8Array)) return no('names', 'there is no signed result for that entry to object to');
  if (hex(o.signedResultId) !== hex(signedResultId))
    return no('names', `that objection is about result ${hex(o.signedResultId).slice(0, 16)}, and the committee signed ${hex(signedResultId).slice(0, 16)}`);

  // 3. THE TRANSCRIPT'S HASH: the bytes carried are the transcript the objection names.
  let t;
  try { t = decodeTranscript(b.transcript); } catch (e) { return no('transcript-hash', `the transcript does not decode: ${e.message}`); }
  const th = transcriptHash(t);
  if (hex(th) !== hex(o.transcriptHash))
    return no('transcript-hash', `the transcript carried hashes to ${hex(th).slice(0, 16)}, and the objection names ${hex(o.transcriptHash).slice(0, 16)}`);

  // 4. THE CHECKPOINT CHAIN: both chains whole, and the marks there to be receipted (inputs + checkpoints, §13A).
  const chain = checkTranscript(t);
  if (!chain.ok) return no('chain', `the chain is broken at ${chain.in} ${chain.at}: ${chain.why}`);
  if (!t.marks.length) return no('chain', 'that transcript carries no checkpoints, so nothing in it was receipted');

  // THE RUN'S INPUTS: the transcript's own batches, or - a live run, whose ticks travel as play frames and whose canonical
  // transcript is its receipted marks over no batches - the bundle's fifth part, as GET /replay/transcript hands it out.
  // Either way the replay below must reproduce every receipted mark's state hash, which is what binds them to the run.
  let form = null;
  if (t.batches.length) form = replayFormOf(t);
  else if (b.inputs) {
    try { form = inputsFormOf(JSON.parse(Buffer.from(b.inputs).toString('utf8'))); }
    catch (e) { return no('chain', `the run's inputs do not read: ${e.message}`); }
  } else return no('chain', 'that transcript carries no inputs, and the objection carries none beside it');

  // 5. IT BELONGS TO THE ENTRY: its round and entry, from the tick the entry joined, within the round's run - and, for
  //    inputs carried beside the transcript, none past the last receipted mark (inputs no committee stood behind).
  if (hex(t.entryId) !== hex(entryId)) return no('entry', 'that transcript is another entry\'s');
  const runTicks = core && Number.isInteger(core.runTicks) ? core.runTicks : null;
  if (t.batches.length) {
    const belongs = transcriptBelongsToEntry(t, entry, runTicks);
    if (!belongs.ok) return no('entry', belongs.why);
  } else {
    if (!form.ticks.length) return no('entry', 'those inputs carry no ticks, so there is nothing that began anywhere');
    if (form.ticks[0].tick !== entry.joinTick)
      return no('entry', `those inputs begin at tick ${form.ticks[0].tick} and that entry joined at ${entry.joinTick}`);
    const reaches = form.ticks[form.ticks.length - 1].tick;
    if (Number.isInteger(chain.throughTick) && reaches >= chain.throughTick)
      return no('entry', `those inputs reach tick ${reaches}, past the last receipted mark at ${chain.throughTick}`);
  }

  // 6. EVERY CHECKPOINT HAS A RECEIPT SIGNED BY A COMMITTEE MEMBER. A receipt from anyone else, or one whose signature
  //    does not verify, refuses the bundle by name: an objection carries evidence, and a forged piece is not evidence.
  if (b.receipts.length % SIGNED_RECEIPT_BYTES !== 0)
    return no('receipts', `${b.receipts.length} bytes is not a whole number of ${SIGNED_RECEIPT_BYTES}-byte signed receipts`);
  const members = new Set((committee || []).map(hex));
  const receipted = new Set();
  for (let at = 0; at < b.receipts.length; at += SIGNED_RECEIPT_BYTES) {
    let r, sig;
    try { const s = splitSignedReceipt(b.receipts.subarray(at, at + SIGNED_RECEIPT_BYTES)); r = decodeCheckpointReceipt(s.body); sig = s.signature; }
    catch (e) { return no('receipts', `receipt ${at / SIGNED_RECEIPT_BYTES} does not decode: ${e.message}`); }
    if (!members.has(hex(r.nodePubkey)))
      return no('receipts', `the receipt from ${hex(r.nodePubkey).slice(0, 16)} is not from this round's committee`);
    let ok = false;
    try { ok = verify(sig, receiptId(r), r.nodePubkey); } catch { ok = false; }
    if (!ok) return no('receipts', `the receipt from ${hex(r.nodePubkey).slice(0, 16)} does not verify`);
    receipted.add(hex(r.checkpointId));
  }
  for (let i = 0; i < t.marks.length; i++) {
    const id = checkpointId(decodeCheckpoint(splitSigned(t.marks[i]).body));
    if (!receipted.has(hex(id))) return no('receipts', `checkpoint ${i} (${hex(id).slice(0, 16)}) carries no receipt from a committee member`);
  }

  // 7. THE REPLAY, UNDER THE ROUND'S OWN CORE: it gives the claimed result, and the claimed result is not the signed one.
  //    A run LIVE at its last tick is scored as the seats score it after the close (§15): at its last receipted mark.
  const marks = t.marks.map((m) => { const c = decodeCheckpoint(splitSigned(m).body); return { tick: c.tick, stateHash: c.stateHash }; });
  let answer;
  try { answer = await replayRun(form, entry, { core, roundRandomness, marks }); } catch (e) { answer = { ok: false, why: e.message }; }
  // THE INPUTS ARE THE RUN THE MARKS RECEIPTED: every mark's state hash reproduced, none left unreached
  if (answer && answer.ok && (answer.divergedAt !== null && answer.divergedAt !== undefined))
    return no('replay', `the inputs do not reproduce the receipted checkpoint at tick ${answer.divergedAt}`);
  if (answer && answer.ok && answer.unchecked > 0)
    return no('replay', `the inputs never reach ${answer.unchecked} of the ${marks.length} receipted checkpoints`);
  if (answer && answer.ok && answer.outcome === null && Number.isInteger(chain.throughTick)) {
    const last = chain.throughTick;
    const cut = (rows) => rows.filter((r) => r[0] < last);
    const prefix = { ticks: form.ticks.filter((x) => x.tick < last), liquidations: cut(form.liquidations), loads: cut(form.loads),
      samples: cut(form.samples), tapes: cut(form.tapes) };
    if (prefix.ticks.length && prefix.ticks.length < form.ticks.length) {
      try { answer = await replayRun(prefix, entry, { core, roundRandomness }); } catch (e) { answer = { ok: false, why: e.message }; }
    }
  }
  const built = resultFrom({ answer, contract, entry, transcript: { ...t, hash: th }, entryId, nodePubkey: NOBODY, stopped: true });
  if (!built.ok) return no('replay', `the transcript does not replay under the round's core: ${built.why}`);
  const replayed = runId(built.result);
  const claimed = runId({ roundId: o.roundId, playerPubkey: o.playerPubkey, outcome: o.claimedOutcome, score: o.claimedScore,
    transcriptHash: o.transcriptHash, simCoreHash: contract.simCoreHash, nodePubkey: NOBODY });
  const facts = { replayedRunId: hex(replayed), claimedRunId: hex(claimed), signedRunId: hex(signedResultId),
    replayed: { outcome: built.result.outcome, score: built.result.score }, claimed: { outcome: o.claimedOutcome, score: o.claimedScore } };
  if (hex(replayed) !== hex(claimed))
    return { ...no('replay', `the replay gives ${built.result.outcome} ${built.result.score}, not the claimed ${o.claimedOutcome} ${o.claimedScore}`), ...facts };
  // THE TEST FAULT, OFF BY DEFAULT (test-dissent.js dissentsOn2026-10-05): for the one named entry this
  // seat's replay counts as differing here too, as it does in finality - the fault's "an objection to it holds here".
  if (hex(claimed) === hex(signedResultId) && !dissentsOn(entryId))
    return { ...no('replay', 'the replay agrees with the signed result'), ...facts };
  return { holds: true, step: null, ...facts, objectorPubkey: hex(o.objectorPubkey),
    why: `the receipts are the committee's and a replay under the round's core gives ${built.result.outcome} ${built.result.score}, contradicting the signed result ${hex(signedResultId).slice(0, 16)}` };
}
