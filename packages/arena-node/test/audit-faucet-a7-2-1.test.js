// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit faucet a7-2-1 (gap in #2818): the faucet's "played a round" list (Season 2: full level only when played, else 25 %) needs more than half
// of up to three seats' season rows since #2818 - but every seat's unsigned `entered` list (kanban #2875) is still taken alone: one configured
// season seat that lists a never-played key in `entered` (its own GET /season, or its scope=network answer) makes that key a player.
// Safe: one seat alone cannot make a key a player, by rows or by `entered`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { networkPlayers } from '../src/feedback-store.js';

test('a7-2-1 one seat\'s unsigned `entered` list alone names a never-played key a player (bypass of #2818)', async () => {
  const X = 'e5'.repeat(32);   // the attacker's reporter key: never entered or played anywhere
  const H = 'a1'.repeat(32);   // an honest player every seat lists
  const fetcher = async (url) => {
    const u = new URL(url);
    const evil = u.host === 'evil.example';
    // the rows agree across seats (the #2818 majority holds); only the lying seat adds X to its own `entered`
    return new Response(JSON.stringify({ rows: [{ player: H, rounds: 5 }], entered: evil ? [H, X] : [H] }), { status: 200 });
  };
  // the lying seat is LAST of four: the #2818 rows read never reaches it, its own GET /season is still read for `entered`
  const np = networkPlayers({ seats: ['https://s2.example', 'https://s3.example', 'https://s4.example', 'https://evil.example'], games: ['rock-paper-scissors'], fetcher });
  await np.refresh();
  console.log('  FACTS a7-2-1:', JSON.stringify({ X: np.played(X), H: np.played(H), historyX: np.history(X) }));
  assert.equal(np.played(H), true, 'control: the honest player is a player');
  assert.equal(np.played(X), false, 'one seat\'s unsigned `entered` named a never-played key a player: his Season 2 report pays the full level, not 25 %');
});

// kanban #3587: the rule holds both ways - an honest entry on two seats (its round's committee) still counts, the scope=network answer's own
// `entered` is not the network's list, and one configured seat keeps working alone
test('#3587 `entered` counts when two seats list a key; the network answer alone and one seat of several do not; a lone seat still decides', async () => {
  const V = 'b2'.repeat(32), X = 'e5'.repeat(32);
  const lists = { 's1.example': [V], 's2.example': [V], 's3.example': [] };
  const fetcher = async (url) => { const u = new URL(url);
    if (u.searchParams.get('scope') === 'network') return new Response(JSON.stringify({ rows: [], entered: [X] }), { status: 200 });
    return new Response(JSON.stringify({ rows: [], entered: lists[u.host] }), { status: 200 }); };
  const np = networkPlayers({ seats: ['https://s1.example', 'https://s2.example', 'https://s3.example'], games: ['rock-paper-scissors'], fetcher });
  await np.refresh();
  assert.equal(np.played(V), true, 'listed by two of three seats: played');
  assert.equal(np.played(X), false, 'only in the scope=network answer: not the network\'s list');
  const lone = networkPlayers({ seats: ['https://s1.example'], games: ['rock-paper-scissors'], fetcher });
  await lone.refresh();
  assert.equal(lone.played(V), true, 'one configured seat: its own list decides, as the #2818 rows do');
});
