// Player sub-seed, the owner 2026-09-08: secret lives on the Entry Contract so
// a node can replay. IMPLEMENTATION.md: H(round_randomness || pubkey || secret || join_tick).
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

export function playerSubSeed({ roundRandomness, playerPubkey, worldSecret, joinTick }) {
  if (!(roundRandomness instanceof Uint8Array) || roundRandomness.length !== 32)
    throw new Error('round_randomness is 32 bytes');
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32)
    throw new Error('player pubkey is 32 bytes');
  if (!(worldSecret instanceof Uint8Array) || worldSecret.length !== 32)
    throw new Error('world secret is 32 bytes');
  if (!Number.isInteger(joinTick) || joinTick < 0)
    throw new Error('join tick is a non-negative integer');
  const w = new Writer();
  w.bytes32(roundRandomness);
  w.bytes32(playerPubkey);
  w.bytes32(worldSecret);
  w.u32(joinTick);
  return taggedHash(TAG.playerSubSeed, w.finish());
}

/** The core's init() takes one uint32; first four bytes of the sub-seed, big-endian. */
export function seedWordFromSubSeed(sub) {
  if (!(sub instanceof Uint8Array) || sub.length !== 32)
    throw new Error('a sub-seed is 32 bytes');
  return ((sub[0] << 24) | (sub[1] << 16) | (sub[2] << 8) | sub[3]) >>> 0;
}

export function seedWordForEntry(entry, roundRandomness) {
  return seedWordFromSubSeed(playerSubSeed({
    roundRandomness,
    playerPubkey: entry.playerPubkey,
    worldSecret: entry.worldSecret,
    joinTick: entry.joinTick,
  }));
}
