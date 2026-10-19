// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TABLE WAITS (2026-10-11, path B): POST /h2h-want?game= records that a page found no round of a
// head-to-head game this seat hosts open; GET /h2h-want answers when that was last said, per game - what the operator's
// grid keeper reads before it publishes the next 30 min of rounds in one transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a page asks for a head-to-head round; the seat keeps when, per game, and refuses a game that is not head-to-head here', async () => {
  const node = await serve(openStore(), { plugins: [...HOSTED, ROCK_PAPER_SCISSORS], port: 0, funded: () => true });
  const at = (p, init) => fetch(`http://127.0.0.1:${node.port}${p}`, init);
  try {
    const rps = toHex(ROCK_PAPER_SCISSORS.gameId);
    assert.deepEqual((await (await at('/h2h-want')).json()).wants, {}, 'nothing asked yet');
    const said = await at(`/h2h-want?game=${rps}`, { method: 'POST' });
    assert.equal(said.status, 200);
    const t = (await said.json()).atMs;
    const got = await (await at('/h2h-want')).json();
    assert.equal(got.wants[rps], t);
    assert.equal((await at(`/h2h-want?game=${toHex(NEXTBLOCK_GAME_ID)}`, { method: 'POST' })).status, 404, 'nextblock is not head-to-head');
    assert.equal((await at('/h2h-want?game=zz', { method: 'POST' })).status, 404);
    assert.equal((await at(`/h2h-want?game=${'ab'.repeat(32)}`, { method: 'POST' })).status, 404, 'a game this seat does not host');
    assert.deepEqual(Object.keys((await (await at('/h2h-want')).json()).wants), [rps]);
  } finally { await node.close(); }
});
