// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 25 (kanban #1523): THE PAGE THE PLAYER LOADS STILL LETS ONE SEAT OF SEVEN STOP EVERY WORLD SEED.
// The fix changed packages/arena-client/src/join.js only. The player's page (src/arena-ui/index.html) loads arena-client.js -
// the bundle - and calls ARENACLIENT.fetchRandomness / ARENACLIENT.worldSeedFor from it. Neither the WebGL template's copy
// (src/arena-ui/arena-client.js) nor dist/arena-client.js was rebuilt after the fix, so the shipped code still throws on the
// first disagreeing beacon: six honest seats, one liar, no world seed for any player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const ROUND = 'ab'.repeat(32);
const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = Array.from({ length: 7 }, (_, i) => `https://seat${i}`);
const fetcher = async (url) => {
  const bytes = url.startsWith('https://seat6') ? BAD : GOOD;
  return { ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => bytes.buffer.slice(0), text: async () => '' };
};

for (const [name, path] of [['the WebGL template (what index.html loads)', '../../../src/arena-ui/arena-client.js'],
                            ['dist', '../dist/arena-client.js']]) {
  test(`${name}: six seats agreeing on the randomness are not overruled by one seat answering other bytes`, async () => {
    const C = req(path);
    let got;
    try { got = await C.fetchRandomness(ROUND, NODES, { fetcher }); }
    catch (e) { assert.fail(`the shipped bundle (${name}) still lets one seat of seven block the round's randomness: ${e.message}`); }
    assert.equal(C.toHex(got.randomness), C.toHex(GOOD));
  });
}
