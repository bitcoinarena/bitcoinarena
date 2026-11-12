// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//: Daniel 2026-11-12 ~06:50Z "Es wird keine rps runde angezeigt": RPS version 10 was hosted (kanban #1481) before any v10 table was
//: posted; the seats listed 44 open v9 rounds, the RPS lobby shows them (ARENA_GAME_IDS reads every version), but the tile counted
//: only the shown version's rounds - "Rock Paper Scissors 14 | 0 | 0" while Tick Tock, which adds its versions up, showed "14 | 0 | 10"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneTilePerGame } from '../src/games.js';

const g = (id, name, version, rounds, players = 0) => ({ id, name, devKey: 'dev', manifest: { version }, live: { rounds, players }, nodes: [] });

test('the Rock Paper Scissors tile counts the open rounds of every version its lobby lists', () => {
  const tiles = oneTilePerGame([g('rps9', 'rock-paper-scissors', 9, 44, 2), g('rps10', 'rock-paper-scissors', 10, 0, 0),
    g('nb6', 'nextblock', 6, 10, 0), g('nb7', 'nextblock', 7, 0, 0), g('ud2', 'btc-updown-15m', 2, 3, 1), g('ud1', 'btc-updown-15m', 1, 5, 0)]);
  const by = Object.fromEntries(tiles.map((t) => [t.name, t]));
  assert.equal(by['rock-paper-scissors'].id, 'rps10', 'the newest version is still the one shown');
  assert.deepEqual(by['rock-paper-scissors'].live, { rounds: 44, players: 2 }, 'RPS: every version\'s rounds counted, as its lobby lists them');
  assert.deepEqual(by.nextblock.live, { rounds: 10, players: 0 }, 'Next Block unchanged');
  assert.deepEqual(by['btc-updown-15m'].live, { rounds: 3, players: 1 }, 'Up/Down still counts only its shown version (its lobby lists one version)');
});
