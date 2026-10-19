// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE SIGNS AFTER IT HAS REPLAYED, AND IT IS THE SPEC'S OWN OBJECT.
//
// Section 13: "Each committee node independently replays the player's
// canonical transcript using the pinned simulation version and signs
// PlayerResult { round_id, player_pubkey, result, score, transcript_hash,
// sim_wasm_hash, node_pubkey, signature }. Once 5-of-7 nodes sign the
// IDENTICAL result, the result becomes PROVISIONALLY_FINAL."
//
// THERE IS NO NEW MESSAGE HERE, and that is deliberate. The obvious thing to
// build was a little attestation carrying the agreed state hash - a node saying
// "I got 9c76f9..." - and the spec has no such object: `state_hash` appears in
// exactly one place, on the player's own Checkpoint. A second signed thing
// meaning almost the same as PlayerResult would be a second protocol, and two
// objects that both say what a run came to are two answers waiting to differ.
// So the agreement is signed as the result the committee was always going to
// sign, and letter 20's board already counts exactly these signatures.
//
// The state hash is what the nodes AGREE on and is not itself a field: two
// nodes that reached the same state produce the same score and the same
// outcome from it, so they produce the same result id, and five identical
// result ids is what section 13 asks for. The hash is the reason the ids
// match, not a thing to sign beside them.
import { frontOfRun } from '../../arena-protocol/src/round-result.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { verifyKept } from './verify-kept.js';
import {
  resultId, encodePlayerResult, decodePlayerResult, splitSignedResult, SIGNED_RESULT_BYTES, signedResultBytesOf,
} from '../../arena-protocol/src/result.js';
import { transcriptHash } from '../../arena-protocol/src/transcript.js';
import { receiptsNeeded } from '../../arena-protocol/src/genesis.js';
import { stoppedOutcome } from '../../arena-protocol/src/first-mark.js';

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * BUILD THE RESULT A REPLAY EARNED.
 *
 * Nothing is passed in that the node does not already hold: the outcome and
 * the score come off the replay, the transcript hash off the stored transcript,
 * the sim hash off the round contract the player signed up to, and the player
 * key off their entry. There is no argument for the outcome or the score,
 * because a node that could be told what a run came to would not need to
 * replay it.
 */
export function resultFrom({ answer, contract, entry, transcript, entryId, nodePubkey, stopped = false, priceRound = false }) {
  if (!answer || !answer.ok) return { ok: false, why: answer ? answer.why : 'no replay to sign' };
  // A RUN STILL LIVE AT ITS LAST TICK came to nothing yet - unless the round
  // has closed on it (`stopped`, the close's own call): then §15 applies, as
  // ruled 2026-09-12 - its checkpoints stopped before the close, the valid run
  // ends at its last receipted one, and it did not deliver (stoppedOutcome).
  let outcome = answer.outcome;
  if (outcome === null) {
    if (!stopped) return { ok: false, why: 'that run is still LIVE at its last stored tick, so it came to nothing yet' };
    // The canonical transcript carries its marks as a count; a built one as a list.
    const marks = !transcript ? 0 : Number.isInteger(transcript.marks) ? transcript.marks
      : Array.isArray(transcript.marks) ? transcript.marks.length : 0;
    outcome = stoppedOutcome({ receiptedMarks: marks, liveAtLast: true, deadlinePassed: true }).outcome;
  }
  if (!contract || !(contract.simCoreHash instanceof Uint8Array))
    return { ok: false, why: 'that round names no simulation core to have replayed under' };
  // THE CORE THAT REPLAYED IS THE ONLY CORE A RESULT MAY NAME (M3 R1). Before, the result took the
  // contract's simCoreHash whatever had run the replay - a signer node could sign "core X" over a replay of
  // core Y. Now the replay says which core ran it (replay.js coreHash), and it must be the round's.
  const named = Array.from(contract.simCoreHash, (b) => b.toString(16).padStart(2, '0')).join('');
  if (typeof answer.coreHash !== 'string' || answer.coreHash !== named)
    return { ok: false, why: `that run was replayed under core ${String(answer.coreHash).slice(0, 16)}, `
      + `not the core ${named.slice(0, 16)} the round names` };
  if (!entry || !(entry.roundId instanceof Uint8Array) || !(entry.playerPubkey instanceof Uint8Array))
    return { ok: false, why: 'that entry names no round or no player' };
  if (!(nodePubkey instanceof Uint8Array)) return { ok: false, why: 'no node is signing this' };

  // AND THE TRANSCRIPT HAS TO BE THIS ENTRY'S.
  //
  // The result takes its player and its round off the ENTRY and its hash off
  // the TRANSCRIPT. Nothing was checking that the two were the same run, so a
  // pairing a caller got wrong - or chose - would produce a properly signed
  // result attributing one player's drive to another, and the board pays on
  // exactly this object. The transcript names its own round and entry, so the
  // check is a comparison and not a new field.
  if (!transcript || !(transcript.roundId instanceof Uint8Array)
    || !(transcript.entryId instanceof Uint8Array))
    return { ok: false, why: 'that transcript names no round or no entry to belong to' };
  if (!same(transcript.roundId, entry.roundId))
    return { ok: false, why: 'that transcript belongs to another round than the entry' };
  if (entryId instanceof Uint8Array && !same(transcript.entryId, entryId))
    return { ok: false, why: 'that transcript belongs to another player than the entry' };

  const result = {
    roundId: entry.roundId,
    playerPubkey: entry.playerPubkey,
    outcome,
    score: answer.score,
    // The canonical transcript already carries its own digest; a second
    // encoding here could differ from the one the committee agreed on.
    transcriptHash: transcript.hash instanceof Uint8Array
      ? transcript.hash : transcriptHash(transcript),
    simCoreHash: contract.simCoreHash,
    nodePubkey,
    // A PRICE ROUND'S RESULT CARRIES THE FRONT ITS RUN ENDED ON (§13 front_*), read off the run's own attested samples
    ...(priceRound ? frontOfRun(transcript.batches) : {}),
  };
  // The bytes come back with it: what is stored and served must be what was
  // signed, not a re-encoding that could differ.
  return { ok: true, result, encoded: encodePlayerResult(result) };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The signature sits BESIDE the result, over its id, the way every signature
 * in this protocol does - so signing cannot move an id and two nodes signing
 * the same run produce the same id to sign.
 */
export function signResult(result, secretKey) {
  const id = resultId(result);
  return { resultId: id, nodePubkey: result.nodePubkey, signature: schnorr.sign(id, secretKey) };
}

/**
 * FIVE OF SEVEN, VERIFIED - which is the part `arena-protocol` cannot do.
 *
 * The board says outright that it COUNTS signatures rather than verifying
 * them, because that package carries no curve. This one has a curve, so here a
 * signature that does not verify is not a signature: it is dropped before the
 * count.
 *
 * AGREEMENT IS ON THE RUN, NOT ON THE BYTES. Section 13's PlayerResult carries
 * `node_pubkey`, so two signer nodes that replayed the same run to the same answer
 * still produce two different result IDS - the record names who made it. Their
 * ids can never match, and counting ids would put every honest committee at
 * one of seven forever. What "the identical result" means is the identical
 * RUN: same round, same player, same outcome, same score, same transcript,
 * same core. So the tally key is the result with the signer removed - a
 * grouping computed here, never signed and never sent, so it adds no object to
 * the protocol.
 *
 * ONE SIGNER NODE, ONE VOTE. A node that signed two results has equivocated; counting
 * both would let one signer node carry two votes and dropping the later one would let
 * arrival order decide which.
 *
 * The threshold comes off the contract's own slots through `receiptsNeeded`.
 * Nothing in this file knows that seven means five.
 */
export function verifiedFinal(records, { contract, signerNodes: joined }) {
  // THE SIGNER NODES ARE THE CENSUS'S. They used to be `contract.nodes` - the list a
  // round's author wrote - so a result from a key the chain never assigned
  // counted towards a final. 26's ruling: the assigned set is the only list
  // that counts, and a round nobody was assigned to has no committee at all.
  if (!Array.isArray(joined) || !joined.length)
    return { ok: false, why: 'that round has no assigned committee to count against' };
  let needed;
  try { needed = receiptsNeeded(contract.gameVerifySlots); }
  catch (err) { return { ok: false, why: err.message }; }

  const signerNodes = new Set(joined.map(hex));
  const seen = new Set();
  const byRun = new Map();
  let forged = 0, doubled = 0, strangers = 0;

  for (const rec of records || []) {
    const bytes = rec instanceof Uint8Array ? rec : rec && rec.bytes;
    // a result's size is its type's (a price round's carries its front, 10 bytes more)
    let size = -1; if (bytes instanceof Uint8Array) { try { size = signedResultBytesOf(bytes); } catch { size = -1; } }
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) { forged++; continue; }

    let result, signature;
    try {
      const split = splitSignedResult(bytes);
      signature = split.signature;
      result = decodePlayerResult(split.body);
    } catch { forged++; continue; }

    const who = hex(result.nodePubkey);
    if (!signerNodes.has(who)) { strangers++; continue; }
    if (seen.has(who)) { doubled++; continue; }
    seen.add(who);

    let ok = false;
    ok = verifyKept(signature, resultId(result), result.nodePubkey);
    if (!ok) { forged++; continue; }

    const run = hex(runId(result));
    byRun.set(run, (byRun.get(run) || 0) + 1);
  }

  let best = null;
  const reached = [];
  for (const [run, count] of byRun) {
    if (best === null || count > best.count) best = { run, count };
    if (count >= needed) reached.push(run);
  }
  // Cannot happen while a threshold is a majority, and refused rather than
  // resolved if a later one is not: two finals for one run is the thing
  // finality exists to prevent.
  if (reached.length > 1)
    return { ok: false, why: 'two different runs each reached the threshold' };

  const final = reached.length === 1;
  return {
    ok: true,
    final,
    runId: final ? reached[0] : null,
    agreed: best ? best.count : 0,
    needed,
    verified: seen.size - doubled - forged >= 0 ? [...seen].length : 0,
    forged,
    doubled,
    strangers,
    why: final ? null : `${best ? best.count : 0} of ${needed} agree on any one run`,
  };
}

/**
 * THE RUN A RESULT DESCRIBES, with the signer taken out.
 *
 * Not a protocol object: nothing signs this and nothing sends it. It exists so
 * two signer nodes' records can be asked "is this the same run?" without the answer
 * being "no, because you are not me".
 */
export const runId = (r) => resultId({ ...r, nodePubkey: new Uint8Array(32) });
