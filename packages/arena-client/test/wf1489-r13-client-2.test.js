// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit #1489 r13 (client): ONE SEAT'S MADE-UP ROUND IDS IN GET /rounds MUST NOT CROWD AN HONEST ROUND OUT OF THE LOBBY'S CONTRACT READS.
// fetchLobby fetches at most LOBBY_CONTRACTS_PER_READ contracts a read, soonest entry close first - the close and the game as ANY seat lists
// them. One seat listing hundreds of made-up ids with the soonest close (and the opened game) fills every read's contract budget with ids no
// seat holds; the honest seats' new round is never fetched, gets no row, and no player can join it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby } from '../src/lobby.js';

test('one seat listing made-up soonest-closing ids does not keep the honest round\'s contract from being read', async () => {
  const game = 'a7'.repeat(32), now = 1_800_000_000_000;
  const real = '5e'.repeat(32);
  const fakes = Array.from({ length: 300 }, (_, i) => (0x100000 + i).toString(16).padStart(64, 'f'));
  const asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.startsWith('http://honest') && u.includes('/rounds?')) return new Response(JSON.stringify({ node: 'c1'.repeat(32), nowMs: String(now),
      rounds: [{ id: real, entryCloseMs: now + 60000, game: { id: game } }] }));
    if (u.startsWith('http://liar') && u.includes('/rounds?')) return new Response(JSON.stringify({ node: 'c2'.repeat(32), nowMs: String(now),
      rounds: fakes.map((id, i) => ({ id, entryCloseMs: now + 10000 + i, game: { id: game } })) }));
    if (u.includes('/round?')) { asked.push(u.split('id=')[1]); return new Response('no such round', { status: 404 }); }
    throw new Error('no such door');
  };
  // three lobby reads a second apart, as the page paints
  for (let k = 0; k < 3; k++)
    await fetchLobby({ nodes: ['http://honest', 'http://liar'], fetcher, verify: () => true, nowMs: now + k * 1000, preferGames: [game] });
  assert.ok(asked.includes(real), `the honest seat's round was never asked for in 3 reads; ${asked.length} contract reads all went to the liar's made-up ids`);
});
