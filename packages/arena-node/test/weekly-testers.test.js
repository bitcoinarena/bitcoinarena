// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MAIN MARKETING METRIC (kanban #926): each player once across games, team keys left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyTesters, teamKeys } from '../tools/weekly-testers.mjs';

const K = (c) => c.repeat(64);

test('a player of two games counts once, a team key not at all, and a row without a finished round not at all', () => {
  const c = weeklyTesters([
    { game: 'a', rows: [{ player: K('1'), rounds: 2 }, { player: K('2'), rounds: 1 }, { player: K('9'), rounds: 5 }, { player: K('3'), rounds: 0 }] },
    { game: 'b', rows: [{ player: K('1'), rounds: 3 }] },
  ], teamKeys(`# bots\n${K('9')} # market bot\nnot a key\n`));
  assert.equal(c.testers, 2);
  assert.equal(c.rounds, 6);
  assert.equal(c.teamLeftOut, 1);
  assert.deepEqual(c.games.map((g) => [g.game, g.testers, g.teamLeftOut]), [['a', 2, 1], ['b', 1, 0]]);
});

test('the list takes upper case and comments, and nothing else', () => {
  assert.deepEqual([...teamKeys(`${K('A')}\n\nxyz\n# ${K('b')}\n`)], [K('a')]);
});
