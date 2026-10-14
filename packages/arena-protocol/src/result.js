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
import { PROTOCOL_VERSION, speaksVersion, TYPE_RESULT, TYPE_RESULT_FRONT, TAG } from './constants.js';
import { frontOf } from './round-result.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from './payout.js';

/** The four fates a round can end in, and the byte each is written as. */
export const OUTCOMES = [DELIVERED, FAILED, FORFEIT, VOID];
export const outcomeByte = (outcome) => {
  const at = OUTCOMES.indexOf(outcome);
  if (at < 0) throw new Error(`${outcome} is not one of ${OUTCOMES.join(', ')}`);
  return at;
};

/**
 * And back. `decodePlayerResult` had this inline; a second object writing an
 * outcome needs the same inverse, and two copies of one mapping is two places
 * for a byte to come to mean different things.
 *
 * ENTRY_VOID is deliberately not one of these. It is payout.js's fifth word
 * for an entry that never activated, and it has no byte here because widening
 * `OUTCOMES` would move every result id. Nothing needs one: 23.2 gives VOID
 * and ENTRY_VOID the same action, which is to do nothing at all.
 */
export const outcomeOf = (byte) => {
  const word = OUTCOMES[byte];
  if (!word) throw new Error(`${byte} is not one of the four outcome bytes`);
  return word;
};

/**
 * Five, of the seven a committee has (13).
 *
 * The same number as 13C's canonical transcript and the client's live-at-five,
 * and for the same reason: no smaller set of nodes can make a result stand.
 */
export const RESULTS_FOR_FINAL = 5;

/** front_mode (§13): LIVE - the run played attested prices; SIM - it did not. */
export const FRONT_MODE = Object.freeze({ LIVE: 1, SIM: 2 });

export function encodePlayerResult(r) {
  // A PRICE ROUND'S RESULT CARRIES ITS FRONT (§13 front_*, kanban #312) under its own type; every other result keeps its 168 bytes and id
  const front = r.front !== undefined && r.front !== null;
  const w = new Writer();
  w.u8(front ? TYPE_RESULT_FRONT : TYPE_RESULT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.roundId);
  w.bytes32(r.playerPubkey);
  w.u8(outcomeByte(r.outcome));
  w.u32(r.score);
  w.bytes32(r.transcriptHash);
  w.bytes32(r.simCoreHash);
  w.bytes32(r.nodePubkey);
  if (front) {
    // the lead at the tick the run ended: BULLS / BEARS / FLAT of the close against the open, as round-result.js says it
    if (r.frontMode !== FRONT_MODE.LIVE && r.frontMode !== FRONT_MODE.SIM) throw new Error('a front is LIVE or SIM');
    if (r.frontMode === FRONT_MODE.LIVE && r.front !== frontOf(r.frontOpenCents, r.frontCloseCents))
      throw new Error('a front must follow from its open and close');
    w.u8(r.front); w.i32(r.frontOpenCents); w.i32(r.frontCloseCents); w.u8(r.frontMode);
  }
  return w.finish();
}

export function decodePlayerResult(bytes) {
  const rd = new Reader(bytes);
  const type = rd.u8();
  if (type !== TYPE_RESULT && type !== TYPE_RESULT_FRONT) throw new Error('not a player result: type ' + type);
  const version = rd.u16();
  if (!speaksVersion(version)) throw new Error('unknown protocol version');
  const out = {
    roundId: rd.bytes32(),
    playerPubkey: rd.bytes32(),
    outcome: OUTCOMES[rd.u8()],
    score: rd.u32(),
    transcriptHash: rd.bytes32(),
    simCoreHash: rd.bytes32(),
    nodePubkey: rd.bytes32(),
  };
  if (type === TYPE_RESULT_FRONT) Object.assign(out, { front: rd.u8(), frontOpenCents: rd.i32(), frontCloseCents: rd.i32(), frontMode: rd.u8() });
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
/** A price round's result: + front (1) + open cents (4) + close cents (4) + mode (1). */
export const RESULT_FRONT_BYTES = RESULT_BYTES + 10;
/** THE SIZE OF THE RESULT STARTING AT `at`, by its type byte (kanban #312): a stream of results cuts record by record. */
export function resultBytesOf(bytes, at = 0) {
  const t = bytes[at];
  if (t === TYPE_RESULT) return RESULT_BYTES;
  if (t === TYPE_RESULT_FRONT) return RESULT_FRONT_BYTES;
  throw new Error(`no player result at ${at}: type ${t}`);
}
export const signedResultBytesOf = (bytes, at = 0) => resultBytesOf(bytes, at) + RESULT_SIGNATURE_BYTES;
/** Cut a stream of signed results; a record that does not fit ends the stream. */
export function cutSignedResults(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    let n; try { n = signedResultBytesOf(body, at); } catch { break; }
    if (at + n > body.length) break;
    out.push(body.subarray(at, at + n)); at += n;
  }
  return out;
}

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
 * signatures over a player, it is a count of distinct COMMITTEE members over
 * one id. Three things, and each was a way to be wrong:
 *
 *   the same id      two nodes signing different results are a disagreement,
 *                    and adding them together would turn that into finality
 *   distinct nodes   one node answering five times is one node
 *   ON THE COMMITTEE five strangers signing the same bytes used to come back
 *                    PROVISIONALLY_FINAL, measured. Nobody is on a committee
 *                    by signing something.
 *
 * A SIGNER WHO IS NOT ON THE COMMITTEE IS IGNORED, not refused. Refusing would
 * let anybody stop a round finalising by sending one stray signature, which is
 * a cheaper attack than the one it prevents. They are counted and named
 * instead.
 *
 * The committee is REQUIRED. An absent one is a refusal, because the version
 * of this that takes an empty list and counts everybody is the version that
 * ships.
 *
 * Signatures are not verified here: this package carries no curve, so the
 * caller passes what it has checked. Committee membership is not a signature
 * question - it is a set - which is why it belongs here and is done here.
 */
export function provisionallyFinal(signedBy, { committee, needed = RESULTS_FOR_FINAL } = {}) {
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!Array.isArray(committee) || !committee.length)
    return { final: false, signers: 0, why: 'no committee to check the signers against' };

  const signerNodes = new Set(committee.map(hex));
  const byResult = new Map();
  let strangers = 0;
  for (const { resultId: id, nodePubkey } of signedBy) {
    if (!signerNodes.has(hex(nodePubkey))) { strangers++; continue; }
    const key = hex(id);
    const who = byResult.get(key) || new Set();
    who.add(hex(nodePubkey));
    byResult.set(key, who);
  }

  let best = null;
  for (const [key, who] of byResult) {
    if (best === null || who.size > best.signers) best = { resultId: key, signers: who.size };
  }
  if (best === null) {
    return {
      final: false,
      signers: 0,
      strangers,
      why: strangers
        ? `nobody on the committee has signed a result; ${strangers} signature(s) came from elsewhere`
        : 'nobody has signed a result',
    };
  }

  return {
    final: best.signers >= needed,
    resultId: best.resultId,
    signers: best.signers,
    strangers,
    why: best.signers >= needed
      ? `${best.signers} of ${needed} committee members signed the same result: PROVISIONALLY_FINAL`
      : `${best.signers} of ${needed} on the strongest result, which is not enough`,
  };
}
