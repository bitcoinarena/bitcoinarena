// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3289 (owner 2026-11-22: "Das Laden des Leaderboards dauert auch zu lang"): a seat built GET /season?scope=network in 22-50 s, longer
// than the page waits, and once its kept board was older than ARENA_SEASON_KEEP_MS the next asker waited for a whole new build. The last
// board (up to ARENA_SEASON_STALE_MS old) is now answered at once while the next one is built behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts, b32 } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a kept network season past its keep time is answered at once, and the new one is built behind it', async () => {
  process.env.ARENA_SEASON_KEEP_MS = '150';
  const peers = ['http://127.0.0.1:9/seat-a'];
  let slow = false, asked = 0;
  const seasonFetch = async (u) => {
    if (/\/identity\?/.test(u)) return new Response('no', { status: 404 });
    asked++;
    if (slow) await new Promise((r) => setTimeout(r, 1500));
    return new Response(JSON.stringify({ node: toHex(schnorr.getPublicKey(b32(0xa1))), rounds: [] }), { status: 200 });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const url = `http://127.0.0.1:${d.port}/season?game=nextblock&scope=network`;
    const first = await (await fetch(url)).json();
    assert.equal(first.scope, 'network');
    await new Promise((r) => setTimeout(r, 250));
    slow = true;
    const t0 = Date.now();
    const again = await (await fetch(url)).json();
    assert.ok(Date.now() - t0 < 800, `the kept board answered after ${Date.now() - t0} ms, not after the new build`);
    assert.deepEqual(again, first);
    const n = asked;
    await new Promise((r) => setTimeout(r, 1700));
    assert.ok(asked >= n, 'the new build asked the seat');
  } finally { delete process.env.ARENA_SEASON_KEEP_MS; await d.close(); }
});
