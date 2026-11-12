// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 25 skeptic 2 (kanban #1523): ONE SEAT STILL PICKS THE BEACON WHEN THE OTHERS HAVE NONE YET.
// The #1523 fix asks "more than half of the NODES THE ROUND NAMED" - but only when the answers disagree. When the honest seats
// answer 409 ("that round has no randomness yet" - a seat that has not read the beacon block, or a cold seat whose beacon read
// is still in flight: main.js randomnessFor answers undefined the first time and refreshes behind it) and one seat answers 32
// bytes, every answer "agrees" and the one seat's bytes are the round's: 1 of 7 named, no majority. The fix's own claim
// ("A minority cannot pick the beacon") does not hold, and the page puts the player in a world nobody replays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fetchRandomness } from '../src/join.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const req = createRequire(import.meta.url);
const ROUND = 'cd'.repeat(32);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = Array.from({ length: 7 }, (_, i) => `https://seat${i}`);
const fetcher = async (url) => {
  if (url.startsWith('https://seat6'))
    return { ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => BAD.buffer.slice(0), text: async () => '' };
  return { ok: false, status: 409, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => 'that round has no randomness yet, so there is no world to drive' };
};

for (const [name, get] of [['src/join.js', async () => ({ fetchRandomness, toHex })],
                           ['the page bundle (src/arena-ui/arena-client.js)', async () => req('../../../src/arena-ui/arena-client.js')]]) {
  test(`${name}: one seat of seven answering while six have no randomness yet does not name the round's world`, async () => {
    const C = await get();
    let got = null;
    try { got = await C.fetchRandomness(ROUND, NODES, { fetcher }); } catch { return; }   // a refusal is the safe answer
    assert.fail(`1 of 7 named nodes picked the round's randomness ${C.toHex(got.randomness)} (agreed ${got.agreed}) - no majority of the named nodes`);
  });
}
