// A checkpoint receipt: a node saying it held this mark at this time.
//
// WHAT THE SPEC GIVES. Section 10, in full: "A checkpoint is accepted when
// enough nodes receive it within the required window; nodes timestamp receipt
// and return a signed CheckpointReceipt. This proves the player committed to
// that state at approximately that real time." The only field list anywhere
// is `IMPLEMENTATION.md:594` - `RECEIPT { checkpoint_hash, received_at,
// node_sig }`. There is no struct for it in the spec the way there is for
// `EntryReceipt`, and no type or tag was reserved for it.
//
// So three things here are DECIDED rather than quoted, and each follows a
// precedent already in this codebase rather than an invention:
//
//   - `nodePubkey` is carried. `IMPLEMENTATION.md`'s wire line omits it,
//     because over a live socket the client knows which node it is talking
//     to. But a receipt is not only a wire message: section 12 puts
//     `receipts[]` inside the round record, where it has to say WHO signed
//     without the connection to ask. `EntryReceipt` (section 7) carries
//     `node_pubkey` for exactly that reason, and this follows it, including
//     its field order - what is receipted, when, by whom.
//
//   - The signature sits BESIDE the object, as it does for a checkpoint. Put
//     inside, it would be covered by `receiptId`, and the id of a receipt
//     would change the moment it was signed.
//
//   - `TYPE_CHECKPOINT_RECEIPT` and `TAG.checkpointReceipt` are new. The spec
//     reserves neither; an object cannot exist without them.
//
// WHAT IS NOT HERE, and it is the larger half: nothing issues one. A node
// signs a receipt with its own key, and this daemon has no key and no place
// to put one - the node identity comes from the bond advertisement, which is
// M2.1 step 5b. The object can be built, hashed and checked now; issuing it
// waits for the node to have an identity to sign with.
//
// `checkpointId` alone names the mark. It is the tagged hash of an object
// that already carries the round and the entry, so repeating them here would
// only add two fields that could disagree with it - the same reason a
// checkpoint names its player by `entryId`.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_CHECKPOINT_RECEIPT, TAG } from './constants.js';

export function encodeCheckpointReceipt(r) {
  const w = new Writer();
  w.u8(TYPE_CHECKPOINT_RECEIPT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.checkpointId);

  // Milliseconds since the epoch, as a u64. The spec's claim is "at
  // approximately that real time" - the node's clock is evidence of what it
  // saw and when, never a source of truth about the round.
  w.u64(r.receivedAtMs);

  w.bytes32(r.nodePubkey);
  return w.finish();
}

export function decodeCheckpointReceipt(bytes) {
  const rd = new Reader(bytes);
  const type = rd.u8();
  if (type !== TYPE_CHECKPOINT_RECEIPT)
    throw new Error('not a checkpoint receipt: type ' + type);
  const version = rd.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const r = {
    checkpointId: rd.bytes32(),
    receivedAtMs: rd.u64(),
    nodePubkey: rd.bytes32(),
  };
  if (rd.at !== bytes.length) throw new Error('trailing bytes after the receipt');
  return r;
}

export const receiptId = (r) => taggedHash(TAG.checkpointReceipt, encodeCheckpointReceipt(r));

/** 1 type, 2 version, 32 checkpoint, 8 time, 32 node. Nothing variable-length. */
export const RECEIPT_BYTES = 1 + 2 + 32 + 8 + 32;

/** The same 64 bytes a checkpoint's signature takes, and for the same reason. */
export const RECEIPT_SIGNATURE_BYTES = 64;

/** A signed receipt on the wire: the receipt, then its signature. */
export const SIGNED_RECEIPT_BYTES = RECEIPT_BYTES + RECEIPT_SIGNATURE_BYTES;

/**
 * Split a wire record into the part that is hashed and the part that signs it.
 * The curve is not this package's business, only the lengths.
 */
export function splitSignedReceipt(bytes) {
  if (bytes.length !== SIGNED_RECEIPT_BYTES)
    throw new Error(
      `a signed receipt is ${SIGNED_RECEIPT_BYTES} bytes, got ${bytes.length}`);
  return {
    body: bytes.subarray(0, RECEIPT_BYTES),
    signature: bytes.subarray(RECEIPT_BYTES),
  };
}

/** The wire record: the encoding followed by the signature over its id. */
export function joinSignedReceipt(bytes, signature) {
  if (signature.length !== RECEIPT_SIGNATURE_BYTES)
    throw new Error(
      `a signature is ${RECEIPT_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(SIGNED_RECEIPT_BYTES);
  out.set(bytes, 0);
  out.set(signature, RECEIPT_BYTES);
  return out;
}
