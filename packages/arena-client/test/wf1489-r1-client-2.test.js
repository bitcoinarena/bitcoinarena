// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r1 client-2: ONE SEAT OF SEVEN CANNOT STOP EVERY PLAYER'S WORLD FROM OPENING.
// fetchRandomness (and worldSeedFor, which the game bridge calls with every node the round named, ARENA_NODES) asks every node
// for the round's randomness and THROWS on the first disagreement. The randomness is a block hash every honest seat reads alike,
// so one seat answering 32 other bytes makes every join's world seed fail for every player of every round it sits on - after the
// stake is locked. Safe: six seats agreeing on the beacon outvote one; the join gets the six's value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRandomness, worldSeedFor } from '../src/join.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = 'ab'.repeat(32);
const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = Array.from({ length: 7 }, (_, i) => `https://seat${i}`);
const fetcher = async (url) => {
  const bytes = url.startsWith('https://seat6') ? BAD : GOOD;
  return { ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => bytes.buffer.slice(0), text: async () => '' };
};

test('six seats agreeing on the round\'s randomness are not overruled by one seat answering other bytes', async () => {
  let got;
  try { got = await fetchRandomness(ROUND, NODES, { fetcher }); }
  catch (e) { assert.fail(`one seat of seven blocked the round's randomness for every player: ${e.message}`); }
  assert.equal(toHex(got.randomness), toHex(GOOD));
});

test('the world seed of an entry is made from the six seats\' randomness', async () => {
  let seed;
  try { seed = await worldSeedFor({ entry: {}, round: ROUND, nodes: NODES, contract: { gameId: new Uint8Array(32) }, fetcher }); }
  catch (e) { if (/two worlds|not one round/.test(e.message)) assert.fail(`one seat blocked the world seed: ${e.message}`); return; }
  assert.equal(toHex(seed.randomness), toHex(GOOD));
});
