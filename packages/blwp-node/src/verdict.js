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
import { ed25519 } from '@noble/curves/ed25519.js';
import { resultId, provisionallyFinal, encodePlayerResult } from '../../protocol/src/result.js';
import { transcriptHash } from '../../protocol/src/transcript.js';
import { receiptsNeeded } from '../../protocol/src/genesis.js';

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
export function resultFrom({ answer, contract, entry, transcript, entryId, nodePubkey }) {
  if (!answer || !answer.ok) return { ok: false, why: answer ? answer.why : 'no replay to sign' };
  if (answer.outcome === null)
    return { ok: false, why: 'that run is still LIVE at its last stored tick, so it came to nothing yet' };
  if (!contract || !(contract.simCoreHash instanceof Uint8Array))
    return { ok: false, why: 'that round names no simulation core to have replayed under' };
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
    outcome: answer.outcome,
    score: answer.score,
    // The canonical transcript already carries its own digest; a second
    // encoding here could differ from the one the committee agreed on.
    transcriptHash: transcript.hash instanceof Uint8Array
      ? transcript.hash : transcriptHash(transcript),
    simCoreHash: contract.simCoreHash,
    nodePubkey,
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
  return { resultId: id, nodePubkey: result.nodePubkey, signature: ed25519.sign(id, secretKey) };
}

/**
 * FIVE OF SEVEN, VERIFIED - which is the part `@blwp/protocol` cannot do.
 *
 * The board says outright that it COUNTS signatures rather than verifying
 * them, because that package carries no curve. This one does, so here a
 * signature that does not verify is not a signature: it is dropped before the
 * count, and the count is then `provisionallyFinal`'s, unchanged.
 *
 * The threshold comes off the contract's own slots through `receiptsNeeded`.
 * Nothing in this file knows that seven means five.
 */
export function verifiedFinal(signedBy, { contract }) {
  if (!contract || !Array.isArray(contract.nodes) || !contract.nodes.length)
    return { ok: false, why: 'that round names no committee' };
  let needed;
  try { needed = receiptsNeeded(contract.gameVerifySlots); }
  catch (err) { return { ok: false, why: err.message }; }

  const seen = new Set();
  const good = [];
  let forged = 0, doubled = 0;
  for (const s of signedBy || []) {
    if (!s || !(s.resultId instanceof Uint8Array) || !(s.nodePubkey instanceof Uint8Array)
      || !(s.signature instanceof Uint8Array)) { forged++; continue; }

    // ONE SEAT, ONE SIGNATURE. A node that signs two different results has
    // equivocated; counting both would let one seat carry two votes, and
    // dropping only the later one would make arrival order decide which.
    const who = hex(s.nodePubkey);
    if (seen.has(who)) { doubled++; continue; }
    seen.add(who);

    let ok = false;
    try { ok = ed25519.verify(s.signature, s.resultId, s.nodePubkey); } catch { ok = false; }
    if (ok) good.push({ resultId: s.resultId, nodePubkey: s.nodePubkey });
    else forged++;
  }

  const seat = provisionallyFinal(good, { committee: contract.nodes, needed });
  return { ok: true, needed, verified: good.length, forged, doubled, ...seat };
}
