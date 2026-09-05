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
// NO SIGNATURE HERE. Section 10 also has `session_signature`, and without it
// this object proves storage and equivocation but NOT that the player
// committed to the state at that time. That claim needs the session key and
// the node's `CheckpointReceipt` beside it, and it is its own slice. A field
// left empty now would only look like the claim was made.
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
