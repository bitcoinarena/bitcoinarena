// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 25 skeptic 3 (kanban #1523): THE PAGE NAMES THE NETWORK'S NODES, NOT THE ROUND'S COMMITTEE.
// The join URL's node= list is the lobby's: daily.json names all 14 testnet4 seats (guardian-1..7, fed2-1..7) and the page
// hands that list to ARENA_NODES -> worldSeedFor -> fetchRandomness. A round is held only by the seats of its committee (about
// half of 14); the others answer 404 "this node holds no such round". readRandomness (07d83f3dd) asks more than half of the
// NAMED nodes on every outcome, so 7 honest committee seats of 14 named (7 x 404) make no world at all - every honest paid join
// stops after the lock (on 85f803d70 this read passed). And with one liar among the 7 committee seats (6 honest), the #1523
// majority is 6 of 14 - the original attack: one seat stops every world seed it sits on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fetchRandomness } from '../src/join.js';

const req = createRequire(import.meta.url);
const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = [...[1, 2, 3, 4, 5, 6, 7].map((n) => `https://tn4.example/guardian-${n}`), ...[1, 2, 3, 4, 5, 6, 7].map((n) => `https://tn4.example/fed2-${n}`)];
const ok = (b) => ({ ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => b.buffer.slice(0), text: async () => '' });
const notHere = { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'this node holds no such round' };
// the round is federation B's: fed2-1..7 are its committee, guardian-1..7 never stored it
const fetcherWith = (liar) => async (url) => {
  const u = String(url);
  if (u.includes('/guardian-')) return notHere;
  if (liar && u.startsWith('https://tn4.example/fed2-7/')) return ok(BAD);
  return ok(GOOD);
};

for (const [name, get] of [['src/join.js', async () => ({ fetchRandomness })],
                           ['the page bundle (src/arena-ui/arena-client.js)', async () => req('../../../src/arena-ui/arena-client.js')]]) {
  test(`${name}: the 7 committee seats of a round agree, 7 other network seats hold no such round - the world is named`, async () => {
    const C = await get();
    const got = await C.fetchRandomness('ab'.repeat(32), NODES, { fetcher: fetcherWith(false) });
    assert.deepEqual([...got.randomness], [...GOOD]);
  });
  test(`${name}: one liar among the 7 committee seats (14 named) does not stop the world seed`, async () => {
    const C = await get();
    const got = await C.fetchRandomness('cd'.repeat(32), NODES, { fetcher: fetcherWith(true) });
    assert.deepEqual([...got.randomness], [...GOOD]);
  });
}
