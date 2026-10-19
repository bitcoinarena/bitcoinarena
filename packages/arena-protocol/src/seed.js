// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Player sub-seed, 2026-09-08: secret lives on the Entry Contract so
// a node can replay. IMPLEMENTATION.md: H(round_randomness || pubkey || secret || join_tick).
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';
import { toHex } from './hash.js';
import { committeeSeedFrom } from './committee-seed.js';

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

/**
 * ONE WORLD PER ROUND, WHERE THE ROUND'S CONFIG SAYS SO (2026-10-04, world grinding; §5A.5
 * round_seed(i) = H(committee_seed(i) || "world")). Under a per-player config the player's own secret, key and join tick
 * made his world, and with the series beacon known a day ahead he could try them offline and enter with the easiest. Under
 * a shared-world config the player picks nothing: every player of the round drives the world of the round itself.
 */
export const TAG_ROUND_WORLD = 'ARENA/v1/RoundWorld';
const WORLD = new TextEncoder().encode('world');

/**
 * Whether a round's config makes one world for the whole round. ASKED OF THE ROUND'S GAME (the engine
 * imports no game): `sharedWorld` is the config hashes (hex) the round's game says share one world - on a node its
 * registration's (plugins.js), on the client its known-games entry (known-game.js sharedWorldOf).
 */
export function worldIsShared(contract, sharedWorld) {
  if (!Array.isArray(sharedWorld)) throw new Error('which configs share one world is the round\'s game\'s to say, and none was given');
  return !!(contract && contract.configHash instanceof Uint8Array && contract.configHash.length === 32
    && sharedWorld.includes(toHex(contract.configHash)));
}

/** round_seed: H(committee_seed || "world") - the committee seed of §5A.5 over the round's census root, id and beacon. */
export function roundWorldSeed({ contract, roundId, roundRandomness }) {
  const seed = committeeSeedFrom({ censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
    roundId, roundRandomness });
  const msg = new Uint8Array(seed.length + WORLD.length); msg.set(seed); msg.set(WORLD, seed.length);
  return taggedHash(TAG_ROUND_WORLD, msg);
}

/**
 * THE ONE FUNCTION every world is made by - the page's join, the signer nodes' replay, the ghosts, the warm path and the
 * replay page: the round's contract chooses the rule by its config hash; a caller that brings no contract is refused, since
 * guessing the rule would drive another world. Shared: the round seed only - no secret, key or join tick of the player's.
 * Otherwise: the per-player seed, byte for byte as before.
 */
export function worldSeedWord({ entry, roundRandomness, contract, roundId, sharedWorld }) {
  if (!contract || !(contract.configHash instanceof Uint8Array))
    throw new Error('no round contract to choose the world rule by: the world is the round config\'s, not the caller\'s');
  if (!worldIsShared(contract, sharedWorld)) return seedWordForEntry(entry, roundRandomness);
  const id = roundId || (entry && entry.roundId);
  if (!(id instanceof Uint8Array) || id.length !== 32) throw new Error('a shared world needs the round id');
  if (!(roundRandomness instanceof Uint8Array) || roundRandomness.length !== 32) throw new Error('round_randomness is 32 bytes');
  return seedWordFromSubSeed(roundWorldSeed({ contract, roundId: id, roundRandomness }));
}

/** On a shared-world round the entry's secret field must be zeros (it is kept so stored entry ids hold). */
export function worldSecretFits(contract, worldSecret, sharedWorld) {
  if (!worldIsShared(contract, sharedWorld)) return { ok: true };
  if (!(worldSecret instanceof Uint8Array) || worldSecret.length !== 32 || worldSecret.some((b) => b !== 0))
    return { ok: false, why: 'this round shares one world among its players: an entry names no world secret (32 zero bytes)' };
  return { ok: true };
}
