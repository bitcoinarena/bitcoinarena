// A PLAYER RESULT: one committee node saying how a round ended for one player.
//
// Section 13, in full: "Each committee node independently replays the player's
// canonical transcript (13C) using the pinned simulation version and signs:
//
//   PlayerResult { round_id, player_pubkey, result, score, transcript_hash,
//                  sim_wasm_hash, node_pubkey, signature }
//
// Once 5-of-7 nodes sign the identical result, the result becomes
// PROVISIONALLY_FINAL and the objection window opens (13A)."
//
// WHAT IS HERE AND WHAT IS NOT. The object, its id, its signature, and the
// arithmetic that says when five of seven have signed THE SAME one. Not the
// replay that produces it, not the objection window, and not the committee -
// this daemon still does not step the simulation, and a result signed without
// a replay behind it is one node's opinion until enough of them agree. That is
// the same shape `CheckpointReceipt` was built in: the object first, issuing
// it later, and it is deliberate rather than half-done.
//
// THE WORD FOR THE OUTCOME is one of the four `payout.js` already has -
// DELIVERED, FAILED, FORFEIT, VOID - and no fifth is added here. A synonym
// would be a second word for one fate and a second place to get it wrong, and
// the payout table reads these four.
//
// `simCoreHash` is the spec's `sim_wasm_hash`. The name follows the round
// contract this repo already signs, so a result and the contract it belongs to
// call the pinned core the same thing.
//
// The signature sits BESIDE the object, as everywhere else here: inside, it
// would be covered by `resultId`, and the id would change the moment it was
// signed.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_RESULT, TAG } from './constants.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from './payout.js';

/** The four fates a round can end in, and the byte each is written as. */
export const OUTCOMES = [DELIVERED, FAILED, FORFEIT, VOID];
export const outcomeByte = (outcome) => {
  const at = OUTCOMES.indexOf(outcome);
  if (at < 0) throw new Error(`${outcome} is not one of ${OUTCOMES.join(', ')}`);
  return at;
};

/**
 * Five, of the seven a committee has (13).
 *
 * The same number as 13C's canonical transcript and the client's live-at-five,
 * and for the same reason: no smaller set of nodes can make a result stand.
 */
export const RESULTS_FOR_FINAL = 5;

export function encodePlayerResult(r) {
  const w = new Writer();
  w.u8(TYPE_RESULT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.roundId);
  w.bytes32(r.playerPubkey);
  w.u8(outcomeByte(r.outcome));
  w.u32(r.score);
  w.bytes32(r.transcriptHash);
  w.bytes32(r.simCoreHash);
  w.bytes32(r.nodePubkey);
  return w.finish();
}

export function decodePlayerResult(bytes) {
  const rd = new Reader(bytes);
  const type = rd.u8();
  if (type !== TYPE_RESULT) throw new Error('not a player result: type ' + type);
  const version = rd.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const out = {
    roundId: rd.bytes32(),
    playerPubkey: rd.bytes32(),
    outcome: OUTCOMES[rd.u8()],
    score: rd.u32(),
    transcriptHash: rd.bytes32(),
    simCoreHash: rd.bytes32(),
    nodePubkey: rd.bytes32(),
  };
  if (rd.at !== bytes.length) throw new Error('trailing bytes after the result');
  if (out.outcome === undefined) throw new Error('that is not one of the four outcomes');
  return out;
}

/** The tagged hash that names a result, and the thing a node signs. */
export const resultId = (r) => taggedHash(TAG.result, encodePlayerResult(r));

export const RESULT_SIGNATURE_BYTES = 64;

/**
 * 1 type + 2 version + 32 round + 32 player + 1 outcome + 4 score
 * + 32 transcript + 32 core + 32 node. Fixed, so a stream of them is
 * self-delimiting and a reader can cut it without a framing convention.
 */
export const RESULT_BYTES = 168;
export const SIGNED_RESULT_BYTES = RESULT_BYTES + RESULT_SIGNATURE_BYTES;

export function joinSignedResult(bytes, signature) {
  if (signature.length !== RESULT_SIGNATURE_BYTES)
    throw new Error(`a signature is ${RESULT_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(bytes.length + RESULT_SIGNATURE_BYTES);
  out.set(bytes, 0);
  out.set(signature, bytes.length);
  return out;
}

export function splitSignedResult(bytes) {
  if (bytes.length <= RESULT_SIGNATURE_BYTES)
    throw new Error(`a signed result is longer than ${RESULT_SIGNATURE_BYTES} bytes`);
  return {
    body: bytes.subarray(0, bytes.length - RESULT_SIGNATURE_BYTES),
    signature: bytes.subarray(bytes.length - RESULT_SIGNATURE_BYTES),
  };
}

/**
 * HOW MANY COMMITTEE MEMBERS HAVE SIGNED THE SAME RESULT.
 *
 * "Once 5-of-7 nodes sign the IDENTICAL result" - so it is not a count of
 * signatures over a player, it is a count of distinct signers over one id.
 * Two nodes signing different results for one player are a disagreement, and
 * counting them together would turn that into finality.
 *
 * Nothing is verified here: the caller passes what it has checked, because
 * this package carries no curve. Signers are counted as a SET, so one node
 * answering five times is one node.
 */
export function provisionallyFinal(signedBy, needed = RESULTS_FOR_FINAL) {
  const byResult = new Map();
  for (const { resultId: id, nodePubkey } of signedBy) {
    const key = [...id].map((b) => b.toString(16).padStart(2, '0')).join('');
    const who = byResult.get(key) || new Set();
    who.add([...nodePubkey].map((b) => b.toString(16).padStart(2, '0')).join(''));
    byResult.set(key, who);
  }

  let best = null;
  for (const [key, who] of byResult) {
    if (best === null || who.size > best.signers) best = { resultId: key, signers: who.size };
  }
  if (best === null) return { final: false, signers: 0, why: 'nobody has signed a result' };

  return {
    final: best.signers >= needed,
    resultId: best.resultId,
    signers: best.signers,
    why: best.signers >= needed
      ? `${best.signers} of ${needed} signed the same result: PROVISIONALLY_FINAL`
      : `${best.signers} of ${needed} on the strongest result, which is not enough`,
  };
}
