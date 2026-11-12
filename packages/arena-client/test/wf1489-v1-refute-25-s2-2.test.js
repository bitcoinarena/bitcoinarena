// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 25 skeptic 2 (kanban #1523): THE WARM READ KEEPS ONE SEAT'S BEACON FOR THE PAGE, SO THE RETRY NEVER ASKS AGAIN.
// index.html warmTheSession calls fetchRandomness at the Join click (default fetch), and the RANDOMNESS map keeps that promise per
// round and node list for the page's life (only a refusal is dropped). If at the click the six honest seats answer 409 (no beacon
// read yet) and one seat answers its own 32 bytes, that value is kept; when worldSeedFor runs later - after the stake is locked,
// with all six honest seats now naming the real block hash - it is answered from the kept promise and the world seed is the one
// seat's. The majority of #1523 is never consulted on the resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRandomness } from '../src/join.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = 'ef'.repeat(32);
const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = Array.from({ length: 7 }, (_, i) => `https://seat${i}`);
const ok = (b) => ({ ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => b.buffer.slice(0), text: async () => '' });
let honestReady = false;
const stub = async (url) => {
  if (String(url).startsWith('https://seat6')) return ok(BAD);
  if (honestReady) return ok(GOOD);
  return { ok: false, status: 409, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'that round has no randomness yet' };
};

test('the world seed after the stake is locked is read from the six honest seats, not the one seat the warm read heard', async () => {
  const was = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    try { await fetchRandomness(ROUND, NODES); } catch { /* the warm read may refuse; that is fine */ }
    honestReady = true;
    // worldSeedFor asks fetchRandomness(id, nodes) with the default fetch - the same key the warm read was kept under
    const b = await fetchRandomness(ROUND, NODES);
    assert.equal(toHex(b.randomness), toHex(GOOD), `the kept warm read (one seat of seven, agreed ${b.agreed}) answered the resumed read`);
  } finally { globalThis.fetch = was; }
});
