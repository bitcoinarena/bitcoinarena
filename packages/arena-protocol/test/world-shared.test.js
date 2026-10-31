// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WORLD GRINDING (2026-10-04: "the player chooses nothing about the world"; §5A.5 round_seed(i) =
// H(committee_seed(i) || "world")). Under config v4 of core 7e2123d1 every player of a round drives one world, made from the
// round alone; under every older config (f51759b6 included) the player's own secret, key and join tick still make it, byte
// for byte as published. And the grinding probe: 10 000 keys and secrets against one round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { worldSeedWord, worldIsShared, worldSecretFits, seedWordForEntry, roundWorldSeed, worldSlot, slotOfEntryId, WORLD_SLOTS } from '../src/seed.js';
import { entryId } from '../src/contracts.js';
import { computeCurrentConfigHash, computeConfigV3Hash } from '../../nextblock/config/game-config.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const r32 = () => new Uint8Array(randomBytes(32));
const ROUND = b32(0x31);
const RANDOMNESS = b32(0x52);
// WHICH CONFIGS SHARE ONE WORLD IS THE ROUND'S GAME'S TO SAY: nextblock's list, as its registration and the
// client's known-games entry give it
const SHARED = [toHex(computeCurrentConfigHash())];
const v4 = { configHash: computeCurrentConfigHash(), censusRoot: b32(0x0c) };
const v3 = { configHash: computeConfigV3Hash(), censusRoot: b32(0x0c) };
const entry = (k, s, j = 0) => ({ roundId: ROUND, playerPubkey: k, worldSecret: s, joinTick: j });
const word = (contract, e) => worldSeedWord({ entry: e, roundRandomness: RANDOMNESS, contract, roundId: ROUND, sharedWorld: SHARED });

test('the configs: v4 (2170f250) shares one world per round, v3 (f51759b6) does not', () => {
  assert.equal(toHex(v4.configHash).slice(0, 8), '2170f250');
  assert.equal(toHex(v3.configHash).slice(0, 8), 'f51759b6');
  assert.equal(worldIsShared(v4, SHARED), true);
  assert.equal(worldIsShared(v3, SHARED), false);
});

test('on a v4 round two players with different keys, secrets and join ticks drive the same world', () => {
  const a = word(v4, entry(b32(1), b32(0), 0));
  const b = word(v4, entry(b32(2), b32(0), 1750));
  const c = word(v4, entry(r32(), r32(), 99));
  assert.equal(a, b);
  assert.equal(a, c, 'a secret moved a shared world');
  // and it is round_seed: another round, or another beacon, is another world
  assert.notEqual(a, worldSeedWord({ entry: entry(b32(1), b32(0)), roundRandomness: RANDOMNESS, contract: v4, roundId: b32(0x32), sharedWorld: SHARED }));
  assert.notEqual(a, worldSeedWord({ entry: entry(b32(1), b32(0)), roundRandomness: b32(0x53), contract: v4, roundId: ROUND, sharedWorld: SHARED }));
  assert.equal(roundWorldSeed({ contract: v4, roundId: ROUND, roundRandomness: RANDOMNESS }).length, 32);
});

test('on a v3 round (the 10-06 series) the world is the player\'s own, exactly as before', () => {
  const e1 = entry(b32(1), b32(7), 0); const e2 = entry(b32(2), b32(7), 0);
  assert.equal(word(v3, e1), seedWordForEntry(e1, RANDOMNESS), 'a published per-player round would replay another world');
  assert.notEqual(word(v3, e1), word(v3, e2));
});

test('a caller that brings no contract is refused: the rule is the round config\'s, not the caller\'s', () => {
  assert.throws(() => worldSeedWord({ entry: entry(b32(1), b32(0)), roundRandomness: RANDOMNESS, roundId: ROUND }), /no round contract/);
});

test('the world secret: zeros fit a v4 round, anything else is refused; any secret fits a v3 round', () => {
  assert.equal(worldSecretFits(v4, b32(0), SHARED).ok, true);
  assert.equal(worldSecretFits(v4, b32(1), SHARED).ok, false);
  const one = b32(0); one[31] = 1;
  assert.match(worldSecretFits(v4, one, SHARED).why, /shares one world among its players/);
  assert.equal(worldSecretFits(v3, r32(), SHARED).ok, true);
});

test('THE GRINDING PROBE: 10 000 keys and secrets give 1 world on a v4 round and ~10 000 on a v3 round', () => {
  const shared = new Set(); const own = new Set();
  for (let i = 0; i < 10000; i++) {
    const k = r32(); const s = r32();
    shared.add(word(v4, entry(k, s, i % 3000)));
    own.add(word(v3, entry(k, s, i % 3000)));
  }
  console.log(`  grinding probe: v4 ${shared.size} distinct world(s), v3 ${own.size} of 10000`);
  assert.equal(shared.size, 1);
  assert.ok(own.size >= 9990, `only ${own.size} worlds on a per-player round`);
});

test('the engine guesses no world rule: a caller that brings no shared-world list from the round\'s game is refused', () => {
  assert.throws(() => worldIsShared(v4), /the round's game's to say/);
  assert.throws(() => worldSeedWord({ entry: entry(b32(1), b32(0)), roundRandomness: RANDOMNESS, contract: v4, roundId: ROUND }), /the round's game's to say/);
});

// A PLACE PER ENTRY IN ONE WORLD (kanban #828): one seed word gave every player of a round one door. The place is the entry id's, for
// shared-world rounds only, and the world's seed word does not move with it.
const fullEntry = (session) => ({ roundId: ROUND, playerPubkey: b32(5), sessionPubkey: session, stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n,
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0),
  stakeLockOutpoint: { txid: b32(0), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) });

test('a shared world gives each entry a place of 0 to 11, off its id; a per-player world gives none', () => {
  const e = fullEntry(b32(1));
  assert.equal(worldSlot({ entry: e, contract: v4, sharedWorld: SHARED }), slotOfEntryId(entryId(e)));
  assert.equal(worldSlot({ entry: e, contract: v3, sharedWorld: SHARED }), undefined);
  assert.throws(() => worldSlot({ entry: e, contract: v4 }), /the round's game's to say/);
  assert.equal(WORLD_SLOTS, 12);
});

test('over 12 000 session keys the twelve places come up evenly, and the key alone moves the place', () => {
  const seen = new Array(12).fill(0);
  for (let i = 0; i < 12000; i++) seen[worldSlot({ entry: fullEntry(r32()), contract: v4, sharedWorld: SHARED })]++;
  console.log('  #828 places over 12 000 keys: ' + seen.join(' '));
  for (const n of seen) assert.ok(n > 850 && n < 1150, `a place came up ${n} times of an expected 1000`);
  assert.equal(word(v4, fullEntry(b32(1))), word(v4, fullEntry(b32(2))), 'a session key moved the world');
});
