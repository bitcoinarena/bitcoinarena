// A checkpoint: where the player says the world was, at a tick both sides
// named beforehand.
//
// WHAT IT BUYS. A transcript already replays: hand the batches to `step` and
// the digest comes out the same, and a flipped bit breaks the chain. What it
// cannot do is say WHERE two runs part company - the answer is "somewhere in
// ninety seconds". A checkpoint is a state hash at roughly one per second, so
// a disagreement is located to a second instead of a round.
//
// AND IT IS THE EQUIVOCATION DETECTOR. Section 13B forfeits a player who
// publishes two different checkpoints for the same tick. That rule needs the
// checkpoint to be an addressable object with a key, which is exactly what
// `(round, entry, tick)` is - so the rule lives in a primary key rather than
// in a check a caller can forget.
//
// THE ENTRY NAMES THE PLAYER. The spec's shape (section 10) carries
// `player_pubkey`; this carries `entryId`, which is the tagged hash OF the
// entry contract, and that contract carries the player's key. One field
// instead of two that could disagree, and it is the key the node already
// stores rounds, ticks and batches under.
//
// THE SIGNATURE SITS BESIDE IT, NOT INSIDE IT. Section 10 lists
// `session_signature` as a field of the checkpoint; carrying it that way
// would put it inside `checkpointId`, and then the id of a mark would change
// the moment it was signed - so `previousHash` would have to name the signed
// id and the chain would shift underneath. Beside it, the id is the same
// whether or not the mark is signed, the chain rule stands, and the record
// stays fixed-size.
//
// What is signed is the tagged id, not the raw encoding: every other object
// in this protocol is committed to through its tagged hash, and keeping that
// means a checkpoint signature can never be replayed as a signature over
// some other object that happens to encode to the same bytes.
//
// The player signs, with the SESSION key - ephemeral, one per run, certified
// by the entry key inside the Entry Contract, so the long-term key is used
// once per entry and never per checkpoint. The verifier is `sessionPubkey`,
// already a field of that contract.
//
// The algorithm and the verifying live in the node. This package stays free
// of crypto dependencies for the same reason `hash.js` takes sha256 from the
// core rather than a library: a thing that pins money should not gain a
// dependency whose version could change its answer.
//
// The state hash comes from the CLIENT. `packages/core`'s `hash(st)` produces
// it, and nothing in the node's `src/` imports the core - the node stores
// bytes it cannot recompute, which is what keeps the daemon a store rather
// than a second simulator.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_CHECKPOINT, TAG } from './constants.js';

/** What the first checkpoint of a round chains to. */
export const NO_PREVIOUS = new Uint8Array(32);

export function encodeCheckpoint(c) {
  const w = new Writer();
  w.u8(TYPE_CHECKPOINT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(c.roundId);
  w.bytes32(c.entryId);

  // Absolute, like the batches'. A checkpoint that numbered its tick relative
  // to anything would need that anything to be agreed first, and the whole
  // point is to name a place both sides can find.
  w.u32(c.tick);

  w.bytes32(c.stateHash);

  // The transcript's chain head at this tick: which inputs produced that
  // state. Without it a checkpoint says where the world was but not which
  // inputs claim to have put it there, and the two could be swapped.
  w.bytes32(c.inputChainHash);

  // The checkpoint before it. The first of a round chains to thirty-two zero
  // bytes, the same convention `InputBatch.previousHash` uses.
  w.bytes32(c.previousHash);
  return w.finish();
}

export function decodeCheckpoint(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_CHECKPOINT) throw new Error('not a checkpoint: type ' + type);
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const c = {
    roundId: r.bytes32(),
    entryId: r.bytes32(),
    tick: r.u32(),
    stateHash: r.bytes32(),
    inputChainHash: r.bytes32(),
    previousHash: r.bytes32(),
  };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the checkpoint');
  return c;
}

export const checkpointId = (c) => taggedHash(TAG.checkpoint, encodeCheckpoint(c));

/**
 * The encoded checkpoint's length: 1 type, 2 version, 4 tick, five 32-byte
 * fields. Nothing here is variable-length, which is what lets a stream of
 * them be cut apart without a framing convention. A test asserts the encoder
 * agrees with this number rather than trusting the arithmetic.
 */
export const CHECKPOINT_BYTES = 1 + 2 + 32 + 32 + 4 + 32 + 32 + 32;

/** An ed25519 signature. The length is the wire's business, the curve is not. */
export const SIGNATURE_BYTES = 64;

/** A signed mark on the wire: the checkpoint, then its signature. */
export const SIGNED_CHECKPOINT_BYTES = CHECKPOINT_BYTES + SIGNATURE_BYTES;

/**
 * Split a wire record into the part that is hashed and the part that signs it.
 *
 * The signature is deliberately NOT decoded here - this package does not know
 * what curve it is - only separated, so the node can hand the two halves to a
 * verifier and this one can go on knowing nothing about keys.
 */
export function splitSigned(bytes) {
  if (bytes.length !== SIGNED_CHECKPOINT_BYTES)
    throw new Error(
      `a signed checkpoint is ${SIGNED_CHECKPOINT_BYTES} bytes, got ${bytes.length}`);
  return {
    body: bytes.subarray(0, CHECKPOINT_BYTES),
    signature: bytes.subarray(CHECKPOINT_BYTES),
  };
}

/** The wire record: the encoding followed by the 64 bytes that sign its id. */
export function joinSigned(bytes, signature) {
  if (signature.length !== SIGNATURE_BYTES)
    throw new Error(`a signature is ${SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(SIGNED_CHECKPOINT_BYTES);
  out.set(bytes, 0);
  out.set(signature, CHECKPOINT_BYTES);
  return out;
}
