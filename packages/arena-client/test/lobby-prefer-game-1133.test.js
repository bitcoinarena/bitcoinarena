// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OPENED GAME'S CONTRACTS FIRST (kanban #1133): the first lobby read on the owner's iPhone fetched 64 contracts of other games first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby, LOBBY_OTHER_CONTRACTS_PER_READ } from '../src/lobby.js';

test('with preferGames the chosen game\'s contracts are asked first, and the others capped', async () => {
  const mine = 'aa'.repeat(32), theirs = 'bb'.repeat(32);
  const ids = [...Array.from({ length: 30 }, (_, i) => ({ id: (i + 0x10).toString(16).padStart(2, '0').repeat(32), game: theirs, close: 1000 + i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: (i + 0xd0).toString(16).padStart(2, '0').repeat(32), game: mine, close: 9000 + i }))];
  const asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes('/rounds')) return new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: '1',
      rounds: ids.map((x) => ({ id: x.id, entryCloseMs: x.close, game: { id: x.game } })) }));
    if (u.includes('/round?')) { asked.push(u.split('id=')[1]); return new Response('no', { status: 404 }); }
    throw new Error('no such door');
  };
  await fetchLobby({ nodes: ['http://n'], fetcher, verify: () => true, nowMs: 1_800_000_000_000, preferGames: [mine] });
  const mineIds = new Set(ids.filter((x) => x.game === mine).map((x) => x.id));
  assert.deepEqual(asked.slice(0, 3).map((id) => mineIds.has(id)), [true, true, true], 'the chosen game\'s contracts were not asked first');
  assert.equal(asked.filter((id) => !mineIds.has(id)).length, LOBBY_OTHER_CONTRACTS_PER_READ, 'the other games\' contracts were not capped');
});
