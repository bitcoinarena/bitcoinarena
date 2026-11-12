// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2046, #1523, #1489: the beacon bar is the round's committee, a seat holding no such round (404) is not a voter -
// and that does not open new ways round it: seats answering 404 cannot shrink a committee round to one seat, a 2-of-2's one
// liar is still refused among 14 named seats, and the warm read without a committee is not what worldSeedFor counts by.
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
const notYet = { ok: false, status: 409, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'that round has no randomness yet' };

for (const [name, get] of [['src/join.js', async () => ({ fetchRandomness })],
                           ['the page bundle (src/arena-ui/arena-client.js)', async () => req('../../../src/arena-ui/arena-client.js')]]) {
  test(`${name}: 13 seats answering 404 do not make one seat's bytes a committee-of-7 round's beacon`, async () => {
    const C = await get();
    const fetcher = async (u) => (String(u).startsWith('https://tn4.example/fed2-7/') ? ok(BAD) : notHere);
    await assert.rejects(C.fetchRandomness('01'.repeat(32), NODES, { fetcher, committee: 7 }), /only 1 of 7/);
  });
  test(`${name}: a 2-of-2 round's one liar among 14 named seats is still refused`, async () => {
    const C = await get();
    const fetcher = async (u) => { const s = String(u);
      if (s.startsWith('https://tn4.example/fed2-1/')) return ok(GOOD);
      if (s.startsWith('https://tn4.example/fed2-2/')) return ok(BAD);
      return notHere; };
    await assert.rejects(C.fetchRandomness('02'.repeat(32), NODES, { fetcher, committee: 2 }), /two worlds/);
    await assert.rejects(C.fetchRandomness('02'.repeat(32), NODES, { fetcher }), /two worlds/);
  });
  test(`${name}: six committee seats not ready (409) and one answering stay refused among 14 named`, async () => {
    const C = await get();
    const fetcher = async (u) => { const s = String(u);
      if (s.includes('/guardian-')) return notHere;
      return s.startsWith('https://tn4.example/fed2-7/') ? ok(BAD) : notYet; };
    await assert.rejects(C.fetchRandomness('03'.repeat(32), NODES, { fetcher, committee: 7 }), /only 1 of 7/);
    await assert.rejects(C.fetchRandomness('03'.repeat(32), NODES, { fetcher }), /only 1 of 7/);
  });
}

test('the warm read (no committee) is shared with the committee-counted read, and counted again by its bar', async () => {
  const was = globalThis.fetch;
  let asks = 0;
  // one committee seat answers, the rest 404: the warm read (no committee known) takes 1 of 1; worldSeedFor's 7 must not
  globalThis.fetch = async (u) => { asks++; return String(u).startsWith('https://tn4.example/fed2-7/') ? ok(BAD) : notHere; };
  try {
    const warm = await fetchRandomness('04'.repeat(32), NODES);
    assert.equal(warm.agreed, 1);
    await assert.rejects(fetchRandomness('04'.repeat(32), NODES, { committee: 7 }), /only 1 of 7/);
  } finally { globalThis.fetch = was; }
  assert.ok(asks >= 14);
});

test('an agreed read of 7 committee seats among 14 named is kept: the second read asks no seat again', async () => {
  const was = globalThis.fetch;
  let asks = 0;
  globalThis.fetch = async (u) => { asks++; return String(u).includes('/guardian-') ? notHere : ok(GOOD); };
  try {
    await fetchRandomness('05'.repeat(32), NODES);
    const n = asks;
    const b = await fetchRandomness('05'.repeat(32), NODES, { committee: 7 });
    assert.equal(asks, n);
    assert.deepEqual([...b.randomness], [...GOOD]);
    assert.equal(b.agreed, 7);
  } finally { globalThis.fetch = was; }
});
