// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE WHOSE READ FAILED IS ASKED FOR A ROUND'S CONTRACT LAST (kanban #1133): the owner's iPhone kept a node list that began with dead
// quick tunnels and stopped seats, and the contracts were asked of those first - twice each, in order - so the lobby read no rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby } from '../src/lobby.js';

test('a round\'s contract is asked of a node that answered before one whose read failed', async () => {
  const id = '1133'.repeat(16);
  const contractAsks = [];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes('/round?')) contractAsks.push(u);
    if (u.startsWith('http://dead')) throw new TypeError('Load failed');
    if (u.includes('/rounds')) return new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: '1', rounds: [{ id }] }));
    if (u.includes('/round?')) return new Response('not a round this client reads', { status: 500 });
    throw new Error('no such door');
  };
  // the dead nodes first, as in the owner's kept list
  const nodes = ['http://dead-1', 'http://dead-2', 'http://live'];
  const got = await fetchLobby({ nodes, fetcher, verify: () => true, nowMs: 1_800_000_000_000 });
  assert.ok(got.failed.includes('http://dead-1') && got.failed.includes('http://dead-2'), got.failed.join(', '));
  assert.ok(contractAsks.length > 0, 'the contract was never asked for');
  assert.ok(contractAsks[0].startsWith('http://live/'), `the first contract ask went to ${contractAsks[0]}, not the node that answered`);
});
