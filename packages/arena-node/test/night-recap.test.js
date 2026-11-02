// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTNET NIGHT RECAP (kanban #926 item 12): the night's window alone, team keys out, a name only with consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recapOf, recapText } from '../tools/night-recap.mjs';

const ID = 'ab'.repeat(32), key = (c) => c.repeat(64);
const round = (n, startMs, entries) => ({ roundId: n.toString(16).padStart(64, '0'), gameId: ID, startMs: BigInt(startMs), void: false,
  entries: entries.map(([p, won]) => ({ player: key(p), name: `name-${p}`, stakeMsat: 100000n, payoutMsat: won ? 200000n : 0n, outcome: won ? 'DELIVERED' : 'FAILED', score: won ? 2 : 0 })) });
const rounds = [round(1, 1000, [['a', true], ['b', false]]), round(2, 1100, [['a', true], ['c', false]]), round(3, 1200, [['b', true], ['f', false]]), round(4, 5000, [['c', true], ['a', false]])];
const games = [{ game: 'rock-paper-scissors', ids: [ID], rounds }];

test('only the night\'s rounds count, team keys are out, and a name needs consent', () => {
  const r = recapOf(games, { fromMs: 900, toMs: 2000, team: new Set([key('f')]), consent: new Set([key('a')]) });
  assert.equal(r.players, 3);
  assert.deepEqual(r.top.map((t) => [t.place, t.named, t.wins]), [[1, 'name-a', 2], [2, 'a tester', 1], [3, 'a tester', 0]]);
  const text = recapText(r, { link: 'https://bitcoinarena.io/night' });
  assert.match(text, /3 players/);
  assert.match(text, /Top 2: 1\. name-a \(2 wins\), 2\. a tester \(1 win\)/);
  assert.ok(!text.includes('name-b'));
});

test('a night nobody played says so in numbers and names no winner', () => {
  const r = recapOf(games, { fromMs: 9000, toMs: 9100 });
  assert.deepEqual([r.players, r.rounds, r.top.length], [0, 0, 0]);
  assert.ok(!/Top/.test(recapText(r)));
});
