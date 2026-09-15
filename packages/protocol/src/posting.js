// A RESULT NOBODY CAN REPLAY DOES NOT SETTLE (v4.6.2 §13A, P2).
//
// "A PROVISIONALLY_FINAL result is not FINAL until the canonical transcript it
// names by transcript_hash has been retrieved by >=5 settlement signer nodes from any
// game/verify node and posted by them to the round's publication_relays[], and
// the window W counts from that posting, not from the fifth signature."
// Without it a quorum that plays for itself sends the honest signer nodes nothing,
// signs what it likes, and nobody ever holds an object to replay.
//
// So there is one object: a signer node's word that it POSTED a run's transcript -
// round, player, the transcript's hash, and the signer node itself in the signed
// bytes. And one count: how many distinct ASSIGNED settlement signer nodes have said it
// about the same transcript, against the round's own threshold (2 of 2 on a
// test net, 5 of 7 otherwise), read off its settlement slots.
//
// A RELAY is any URL the contract names - "data, not infrastructure". What a
// signer node puts there is the transcript's bytes at `/transcript/<its hash>`, and
// the object verifies itself: a relay keeps bytes only under the hash they
// have, so a relay cannot serve one transcript under another's name.
//
// The curve is not this package's business: `verify(signature, digest, key)`
// is injected, as `claim-key.js` takes it.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_TRANSCRIPT_POSTING, TAG } from './constants.js';
import { receiptsNeeded } from './threshold.js';

/** 1 type + 2 version + 32 round + 32 player + 32 transcript + 32 signer node. */
export const POSTING_BYTES = 131;
export const POSTING_SIGNATURE_BYTES = 64;
export const SIGNED_POSTING_BYTES = POSTING_BYTES + POSTING_SIGNATURE_BYTES;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeTranscriptPosting(p) {
  const w = new Writer();
  w.u8(TYPE_TRANSCRIPT_POSTING);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(p.roundId);
  w.bytes32(p.playerPubkey);
  w.bytes32(p.transcriptHash);
  // WHO SAYS SO is in the signed bytes, so a signature cannot be moved from one
  // signer node's record to another's.
  w.bytes32(p.signerNodePubkey);
  return w.finish();
}

export function decodeTranscriptPosting(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_TRANSCRIPT_POSTING) throw new Error('not a transcript posting');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const p = { roundId: r.bytes32(), playerPubkey: r.bytes32(), transcriptHash: r.bytes32(), signerNodePubkey: r.bytes32() };
  r.end();
  return p;
}

/** What one signer node signs. */
export const transcriptPostingId = (p) => taggedHash(TAG.transcriptPosting, encodeTranscriptPosting(p));

export function joinSignedPosting(body, signature) {
  if (body.length !== POSTING_BYTES) throw new Error(`a posting is ${POSTING_BYTES} bytes, got ${body.length}`);
  if (signature.length !== POSTING_SIGNATURE_BYTES)
    throw new Error(`a signature is ${POSTING_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(SIGNED_POSTING_BYTES);
  out.set(body, 0);
  out.set(signature, POSTING_BYTES);
  return out;
}

export function splitSignedPosting(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_POSTING_BYTES)
    throw new Error(`a signed posting is ${SIGNED_POSTING_BYTES} bytes`);
  return { body: bytes.subarray(0, POSTING_BYTES), signature: bytes.subarray(POSTING_BYTES) };
}

/** The name a relay keeps a transcript under: the transcript's own id over its bytes. */
export const transcriptBytesHash = (bytes) => taggedHash(TAG.transcript, bytes);
export const relayPath = (hash) => `/transcript/${toHex(hash)}`;

/**
 * HAS THIS TRANSCRIPT BEEN POSTED BY THE ROUND'S THRESHOLD OF SETTLEMENT SIGNER NODES?
 *
 * Counted over the round's ASSIGNED committee, once per signer node: a posting from a
 * key that is not assigned, a second one from the same signer node, one about another
 * round, player or transcript, and one that does not verify all count for
 * nothing. `postings` are `{ bytes, seenMs }` as a node stores them; `atMs` is
 * when the posting that completed the threshold arrived here - where W opens.
 */
export function transcriptIsPublished({
  roundId, playerPubkey, transcriptHash, postings, signerNodes, settlementSlots, verify,
} = {}) {
  if (!is32(roundId) || !is32(playerPubkey) || !is32(transcriptHash))
    return { ok: false, posted: 0, why: 'a posting is counted for one round, one player and one 32-byte transcript hash' };
  if (typeof verify !== 'function') return { ok: false, posted: 0, why: 'counting postings needs a verifier, and none was injected' };
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    return { ok: false, posted: 0, why: 'this round has no assigned settlement committee to post its transcripts' };
  let needed;
  try { needed = receiptsNeeded(settlementSlots); } catch (e) { return { ok: false, posted: 0, why: e.message }; }

  const joined = new Set(signerNodes.map(toHex));
  const want = [toHex(roundId), toHex(playerPubkey), toHex(transcriptHash)].join(':');
  const counted = new Map();
  for (const rec of postings || []) {
    let p, signature;
    try {
      const split = splitSignedPosting(rec && rec.bytes);
      signature = split.signature;
      p = decodeTranscriptPosting(split.body);
    } catch { continue; }
    const who = toHex(p.signerNodePubkey);
    if (!joined.has(who) || counted.has(who)) continue;
    if ([toHex(p.roundId), toHex(p.playerPubkey), toHex(p.transcriptHash)].join(':') !== want) continue;
    let good = false;
    try { good = !!verify(signature, transcriptPostingId(p), p.signerNodePubkey); } catch { good = false; }
    if (good) counted.set(who, Number(rec.seenMs));
  }

  if (counted.size < needed)
    return {
      ok: false, posted: counted.size, needed,
      why: `${counted.size} of ${needed} settlement signer nodes have posted this run's transcript to the round's publication relays`,
    };
  const atMs = [...counted.values()].sort((a, b) => a - b)[needed - 1];
  return { ok: true, posted: counted.size, needed, atMs };
}
