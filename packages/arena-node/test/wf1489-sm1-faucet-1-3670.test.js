// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 sm1-faucet-1 (state audit, after kanban #3587): the `entered` majority counts only the seats that answered (bySeat.size), not the
// configured ones. A refresh while the other seats time out (a restart, load: the #2565 case) leaves one answering seat, need = 1, and that
// one seat's unsigned list alone names a never-played key a player - the rows read in the same refresh needs min(2, seats) answers and keeps
// its last list. Invariant (#3587's own): one seat alone never makes a key a player, by rows or by `entered`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { networkPlayers } from '../src/feedback-store.js';

test('#3670 sm1-faucet-1 with the other seats timing out, one seat\'s `entered` alone names a never-played key a player', async () => {
  const X = 'e5'.repeat(32);
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.host !== 'evil.example') throw new Error('The operation was aborted due to timeout');   // the honest seats: no answer this refresh
    return new Response(JSON.stringify({ rows: [], entered: [X] }), { status: 200 });
  };
  const np = networkPlayers({ seats: ['https://s1.example', 'https://s2.example', 'https://s3.example', 'https://evil.example'], games: ['rock-paper-scissors'], fetcher });
  await np.refresh();
  console.log('  FACTS sm1-faucet-1:', JSON.stringify({ played: np.played(X), history: np.history(X) }));
  assert.equal(np.played(X), false, 'one answering seat of four named a never-played key a player (need fell to 1)');
});
