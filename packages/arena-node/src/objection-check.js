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
import { loadValueRefusal, loadShapeRefusal } from './load-checks.js';

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

/**
 * The run's inputs as GET /replay/transcript hands them out (readTranscript's shape), checked for that shape - AND IN ONE
 * FORM (kanban #1706, the #1517 recheck): an event row is applied only before a tick the run steps (core-driver.js calls
 * `before` at each stepped tick and at no other), so a row at a tick outside the ticks carried is dropped here, and the
 * rest are put in tick order. A row wider than its kind (the store's own columns: liquidations and samples [tick, value],
 * loads [tick, fee, btc] or [tick, fee, btc, room], tapes [tick, prices...]) or a second row of one kind at one tick
 * (the store keeps one: PRIMARY KEY (round, entry, tick)) is refused by name. Copies of one run that differ only in rows
 * no replay applies are then one input, one replay key (replayKeyOf), one answer.
 */
export function inputsFormOf(j) {
  const rows = (x, name) => { if (!Array.isArray(x)) throw new Error(`${name} is not a list`); return x; };
  const ticks = rows(j && j.ticks, 'ticks').map((r, i) => {
    if (!r || !Number.isInteger(r.tick) || !Array.isArray(r.words) || !r.words.every(Number.isInteger)) throw new Error(`tick row ${i} is not { tick, words }`);
    return { tick: r.tick, words: r.words };
  });
  const from = ticks.length ? ticks[0].tick : 0;
  const to = ticks.length ? ticks[ticks.length - 1].tick : -1;
  const ints = (x, name, min, max) => {
    const seen = new Set();
    return rows(x || [], name).map((r, i) => {
      // a drawn bed's load (kanban #2574) carries a fifth element, its parcels [[slot, txid hex], ...]; every other element is an integer
      const parcels = name === 'loads' && Array.isArray(r) && r.length === 5 ? r[4] : undefined;
      if (parcels !== undefined && !(Array.isArray(parcels) && parcels.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && /^[0-9a-f]{64}$/.test(String(p[1])))))
        throw new Error(`${name} row ${i} names its parcels as [[slot, txid], ...]`);
      if (!Array.isArray(r) || !(parcels === undefined ? r : r.slice(0, 4)).every(Number.isInteger)) throw new Error(`${name} row ${i} is not a list of integers`);
      if (r.length < min || r.length > max) throw new Error(`${name} row ${i} carries ${r.length} integers, and a ${name} row carries ${min === max ? min : `${min} to ${max}`}`);
      if (seen.has(r[0])) throw new Error(`${name} row ${i} is a second one at tick ${r[0]}`);
      seen.add(r[0]);
      return r;
    }).filter((r) => r[0] >= from && r[0] <= to).sort((a, b) => a[0] - b[0]);
  };
  return { ticks, liquidations: ints(j.liquidations, 'liquidations', 2, 2), loads: ints(j.loads, 'loads', 3, 5),
    samples: ints(j.samples, 'samples', 2, 2), tapes: ints(j.tapes, 'tapes', 1, Infinity) };
}

/**
 * THE KEY OF ONE REPLAY (kanban #1517, #1706): the replay form and the marks it must reproduce, as JSON in a fixed order,
 * hashed by the caller. Two inputs with one key are one replay with one answer; the seat's objection door caches by it.
 */
export function replayKeyOf(form, marks) {
  return JSON.stringify([
    [form.ticks.map((x) => [x.tick, x.words]), form.liquidations, form.loads, form.samples, form.tapes],
    (marks || []).map((m) => [m.tick, hex(m.stateHash)])]);
}

/**
 * THE REPLAY KEY OF A LIVE RUN'S BUNDLE, BEFORE ANY CHECK (kanban #1878): the key replayKeyOf gives the inputs a live
 * run's bundle carries, with its marks - or null for a batch transcript, or bytes that do not read (those go through the
 * whole check, which names why). A seat's door reads it to refuse, without queueing, a further variant past its cap.
 */
export function liveRunKeyOf(bundle) {
  try {
    const b = decodeObjectionBundle(bundle);
    const t = decodeTranscript(b.transcript);
    if (t.batches.length || !b.inputs) return null;
    const form = inputsFormOf(JSON.parse(Buffer.from(b.inputs).toString('utf8')));
    const marks = t.marks.map((m) => { const c = decodeCheckpoint(splitSigned(m).body); return { tick: c.tick, stateHash: c.stateHash }; });
    return replayKeyOf(form, marks);
  } catch { return null; }
}

/**
 * WHY THE LOADS OF A LIVE RUN'S INPUTS ARE ONES THE BATCH DOOR NEVER TAKES, or null (kanban #1952, #1990 - a refute of
 * #1488, Hexbox #011). A live run's inputs travel beside the transcript as free JSON, bound only by the receipted marks'
 * state hashes - which the player computed himself. So a player sent the seats an honest bed, signed his mark over a full
 * bed at 0 sats / 0 BTC, got it receipted, and objected with inputs carrying that bed: the replay reproduced the mark, gave
 * +41 %, and the objection held (a second one after the re-run VOIDed the entry). The same rules as Round.batch's
 * loadsRefusal, on the whole run: every load's values (loadValueRefusal), at most one a tick, at a tick the run reaches
 * (its first .. one past its last, a batch of no ticks reaching the next), and before the first tick with a control word.
 */
export function inputsLoadRefusal(form, drawn = null) {
  const loads = form.loads || [];
  if (!loads.length) return null;
  // A BED OF DRAWN PARCELS (kanban #2574): on a core that draws its parcels, the inputs' loads are held to the snapshot exactly as
  // at the batch door (Round.batch loadsRefusal) - not to the declared-bed floors, which an honest drawn bed of cheap parcels can
  // be under; on any other core a load naming parcels is not one the door ever took
  if (!drawn) {
    const named = loads.find((l) => l.length > 4 && Array.isArray(l[4]) && l[4].length);
    if (named) return `the load at tick ${named[0]} names parcels, and this round's core does not draw them`;
  } else if (drawn.why) return drawn.why;
  const first = form.ticks.length ? form.ticks[0].tick : null;
  const last = form.ticks.length ? form.ticks[form.ticks.length - 1].tick : null;
  const driven = form.ticks.find((r) => r.words.slice(0, 4).some((w) => w !== 0));
  const seen = new Set();
  for (const l of loads) {
    const tick = l[0];
    if (first === null || tick < first || tick > last + 1)
      return `the load at tick ${tick} is not at a tick those inputs reach (${first} .. ${last === null ? null : last + 1}): a load goes out with the batch that reaches its tick`;
    if (seen.has(tick)) return `two loads at tick ${tick}: a page declares at most one a tick`;
    seen.add(tick);
    const why = drawn ? (loadShapeRefusal(l) || drawn.check(l)) : loadValueRefusal(l);
    if (why) return why;
    if (driven && driven.tick < tick)
      return `the load at tick ${tick} comes after the truck was driven at tick ${driven.tick}: a bed is declared before ROLL OUT`;
  }
  return null;
}

/**
 * WHERE A LIVE RUN'S INPUTS DIFFER FROM WHAT THIS SEAT STORED, or null (kanban #1952, #1990). Every input a seat stores
 * came in a batch the entry's session key signed (Round.signedBatch, or a signed mark endorsing it), so over the ticks the
 * seat holds, inputs other than its stored ones are not the run the player sent - they are a run he signed marks over
 * and never played. Compared over the ticks both hold: from the run's start to the earlier of the seat's last held tick
 * and the inputs' last tick. A seat holding no tick of the run binds nothing (the stranger's checker never passes one).
 */
export function inputsDifferFromStored(form, stored) {
  if (!stored || !Array.isArray(stored.ticks) || !stored.ticks.length || !form.ticks.length) return null;
  const upto = Math.min(stored.ticks[stored.ticks.length - 1].tick, form.ticks[form.ticks.length - 1].tick) + 1;
  const tickRows = (rows) => JSON.stringify(rows.filter((r) => r.tick < upto).map((r) => [r.tick, [...r.words]]));
  if (tickRows(form.ticks) !== tickRows(stored.ticks)) return 'ticks';
  for (const name of ['liquidations', 'loads', 'samples', 'tapes']) {
    const rows = (x) => JSON.stringify((x || []).filter((r) => r[0] < upto).map((r) => [...r]));
    if (rows(form[name]) !== rows(stored[name])) return name;
  }
  return null;
}

/**
 * CHECK ONE OBJECTION BUNDLE. `bundle` the bytes posted; `roundId`, `entryId` the run it is filed against; `entry` that
 * entry's signed contract; `contract` the round's; `committee` its signer nodes' keys; `signedResultId` the run the
 * committee signed (the agreed re-run's, for a second objection); `core` the round's core as the seat resolves it
 * (with its `runTicks` and `world`); `roundRandomness` the round's beacon; `verify(sig, msg, pubkey)` BIP-340.
 * `replayRun(form, entry, options)` defaults to the core's own `replay`; a seat hands its worker pool's, same answer.
 * `storedInputs` (a seat's own readTranscript of the entry, optional): a live run's inputs must be the ones it stored.
 * Returns `{ holds, step, why, ... }` - `step` names the check that refused.
 *
 * A seat also hands (kanban #1706, #1878; the arbiter and the command line hand none): `ownInputs()` its own stored run;
 * `knownRun(marks)` the run it remembered as reproducing those marks; `referenceRuns()` (async) the runs committee seats
 * hand out (GET /replay/transcript); `keepRun(form, key)` told of a run that reproduced every mark; `admitReplay(key)`
 * asked before a live run's carried inputs are replayed - false refuses them by name, unreplayed.
 */
export async function checkObjectionBundle({ bundle, roundId, entryId, entry, contract, committee, signedResultId,
  core, roundRandomness, verify, storedInputs = null, replayRun = async (form, e, options) => replay(form, e, options), ownInputs = null,
  knownRun = null, referenceRuns = null, keepRun = null, admitReplay = null, drawn = null }) {
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
    // NO LOAD THE BATCH DOOR REFUSES (kanban #1952, #1990): what a live run's inputs carry is held to the same rules
    const loadWhy = inputsLoadRefusal(form, drawn);
    if (loadWhy) return no('inputs', `those inputs carry a load no honest bed declares: ${loadWhy}`);
    // AND, AT A SEAT, THE RUN IT STORED (kanban #1952, #1990): inputs the player's session key never signed are not his run
    const differs = inputsDifferFromStored(form, storedInputs);
    if (differs)
      return no('inputs', `those inputs' ${differs} are not the ones this seat stored for that entry, which the player's session key signed: a mark over inputs never sent is the player's own, not the committee's`);
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

  // 7a. A LIVE RUN'S INPUTS THAT ARE NOT THE RUN THIS SEAT HOLDS (kanban #1706, the #1517 recheck). A live run's inputs
  //     are bound to the marks only by the replay, so a stranger holding the public transcript, receipts and inputs could
  //     change one word per copy and buy one full replay per copy, the entry held SUSPENDED behind each (#1225). A seat
  //     hands `ownInputs` (its own stored ticks and events of the entry; the arbiter and the command line hand none and
  //     check as before). When the inputs carried differ from those, this seat replays ITS OWN run over the same span and
  //     marks once - one key per entry, the key an honest bundle of that run shares. If that run reproduces every
  //     receipted mark and gives the signed result, no inputs can hold an objection here: any that reach every mark reach
  //     the state the seat's own run reached at the last one (a run carried here ends before it), so they give the signed
  //     result too, and any that do not are refused at the marks. Refused by name, without replaying them. If this seat's
  //     own run does not (it missed inputs, or signed wrong), the inputs carried are replayed as before.
  //
  //     AND A SEAT THAT DOES NOT HOLD THE WHOLE RUN (kanban #1878): one behind on the feed (5 of 7 lets the player move
  //     on), one that missed the tail across a restart, or one fed a divergent frame holds a run that does not reproduce
  //     the marks - and 7a used to fall through there, every one-word copy a full replay again. So the runs tried are, in
  //     turn: the run this seat REMEMBERED as reproducing these marks (the first one that did, carried or fetched), its
  //     own, and the runs committee seats hand out (referenceRuns, fetched only when the others did not reproduce them).
  //     Each is one replay key, replayed at most once (the seat's cache). The first that reproduces every mark decides:
  //     it gives the signed result - the inputs carried are refused by name, unreplayed - or it does not (the committee
  //     may have signed wrong), and the inputs carried are replayed as before.
  const live = !t.batches.length && Number.isInteger(chain.throughTick) && !dissentsOn(entryId);
  const formKey = live ? replayKeyOf(form, marks) : null;
  const reproduces = (a) => !!(a && a.ok && (a.divergedAt === null || a.divergedAt === undefined) && !(a.unchecked > 0));
  if (live) {
    const over = (run) => {
      try {
        if (!run || !Array.isArray(run.ticks) || !run.ticks.length) return null;
        const cut = (r) => r[0] < chain.throughTick;
        const mine = inputsFormOf({ ...run, ticks: run.ticks.filter((x) => x && x.tick >= form.ticks[0].tick && x.tick < chain.throughTick),
          liquidations: (run.liquidations || []).filter(cut), loads: (run.loads || []).filter(cut), samples: (run.samples || []).filter(cut), tapes: (run.tapes || []).filter(cut) });
        return mine.ticks.length ? mine : null;
      } catch { return null; }
    };
    const tried = new Set();
    let vouched = false;
    // 'refuse', 'carried' (replay the inputs carried), or null (try the next run)
    const tryRun = async (mine) => {
      if (!mine) return null;
      const key = replayKeyOf(mine, marks);
      // the carried inputs ARE a run this seat holds or a committee seat handed out (kanban #2017, #2051): replayed as
      // they are, never capped - a fetched reference that is the true run must not be refused as one variant too many
      if (key === formKey) { vouched = true; return 'carried'; }
      if (tried.has(key)) return null;
      tried.add(key);
      let own;
      try { own = await replayRun(mine, entry, { core, roundRandomness, marks }); } catch (e) { own = { ok: false, why: e.message }; }
      if (!reproduces(own)) return null;
      vouched = true;
      if (typeof keepRun === 'function') { try { keepRun(mine, key); } catch { /* remembering is a saving, never a verdict */ } }
      const ownBuilt = resultFrom({ answer: own, contract, entry, transcript: { ...t, hash: th }, entryId, nodePubkey: NOBODY, stopped: true });
      return ownBuilt.ok && hex(runId(ownBuilt.result)) === hex(signedResultId) ? 'refuse' : 'carried';
    };
    let verdict = null;
    if (typeof knownRun === 'function') { let k = null; try { k = knownRun(marks); } catch { k = null; } verdict = await tryRun(k && Array.isArray(k.ticks) ? k : null); }
    if (!verdict && typeof ownInputs === 'function') { let o = null; try { o = ownInputs(); } catch { o = null; } verdict = await tryRun(over(o)); }
    if (!verdict && typeof referenceRuns === 'function') {
      let refs = [];
      try { refs = (await referenceRuns()) || []; } catch { refs = []; }
      for (const r of refs) { verdict = await tryRun(over(r)); if (verdict) break; }
    }
    if (verdict === 'refuse')
      return no('replay', 'those inputs are not the run this seat holds for that entry, and the run it holds reproduces every receipted '
        + 'checkpoint and gives the signed result - inputs that reach the same checkpoints give it too (kanban #1706, #1878)');
    // A BOUNDED NUMBER OF OTHER INPUTS PER ENTRY (kanban #1878): with no run here to check them against, each distinct
    // set of inputs is a full replay; past the seat's cap a further one is refused by name, unreplayed.
    // Only where NO run reproduced the marks (kanban #2017, #2051): when one did and it does not give the signed result
    // (the committee signed wrong), the carried inputs are what a genuine objection is checked by - never capped.
    if (!vouched && typeof admitReplay === 'function' && !admitReplay(formKey))
      return no('replay', 'this seat has already replayed as many different inputs for that entry\'s live run as it replays for one entry, '
        + 'and holds no run of it that reproduces the receipted checkpoints to check these against - refused without a replay (kanban #1878)');
  }

  let answer;
  try { answer = await replayRun(form, entry, { core, roundRandomness, marks }); } catch (e) { answer = { ok: false, why: e.message }; }
  // THE FIRST CARRIED RUN THAT REPRODUCES EVERY MARK is this seat's reference for the entry from now on (kanban #1878)
  if (live && reproduces(answer) && typeof keepRun === 'function') { try { keepRun(form, formKey); } catch { /* a saving only */ } }
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
