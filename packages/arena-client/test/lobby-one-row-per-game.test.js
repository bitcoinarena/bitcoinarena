// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE ROW PER GAME, WHATEVER ITS VERSIONS (2026-10-16 06:25Z: "games show up as duplicates it's always the same
// round twice"). Measured on seat 3 at 06:49Z: every 90 s instant listed nextblock v1 on federation A, v1 on B and v3 (b8b88e23) on
// A; the lobby kept one row per game ID, so v1's and v3's rounds of one instant were two rows. Rows are kept per game NAME now, and of
// two rounds of one instant the newer version wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lobbyOnePerKind } from '../src/lobby.js';

const V1 = '495516ae59539661062cd72fd8716afbb378bd386297ab09b20aba0a2cd44150';
const V3 = 'b8b88e233baac6671c8ac6da8193f816d7f552423a3888b184018b7b49839651';
const sid = new Uint8Array(32).fill(1);
const row = (id, game, gameRank, startMs, extra = {}) => ({ id, game, gameName: 'nextblock', gameRank, free: false, joinable: true, phase: 'open',
  stakeMsat: 100000n, entryCloseMs: startMs + 45000, contract: { seriesId: sid, startTimeMs: BigInt(startMs), roundIndex: 0 }, ...extra });

test('v1 and v3 rounds of one instant are one row - the newer version; another instant does not change that', () => {
  const now = 1792140000000, at = now + 30000;
  const rows = [row('v1a', V1, 1, at), row('v1b', V1, 1, at), row('v3a', V3, 10, at)];
  const kept = lobbyOnePerKind(rows, now);
  assert.equal(kept.length, 1, `one row, not ${kept.map((r) => r.id).join(', ')}`);
  assert.equal(kept[0].id, 'v3a');
  // the soonest round still decides first: a v1 round closing earlier is the row
  const sooner = lobbyOnePerKind([row('v3late', V3, 10, at + 90000), row('v1soon', V1, 1, at)], now);
  assert.deepEqual(sooner.map((r) => r.id), ['v1soon']);
});

test('a market stays its own row beside the game; a row with no known name keeps its id as before', () => {
  const now = 1792140000000, at = now + 30000;
  const market = { ...row('m', 'cc'.repeat(32), 1, at), gameName: 'btc-updown-15m' };
  const unknown = { ...row('u', 'dd'.repeat(32), 0, at), gameName: '' };
  const kept = lobbyOnePerKind([row('v3a', V3, 10, at), market, unknown], now);
  assert.deepEqual(kept.map((r) => r.id).sort(), ['m', 'u', 'v3a']);
});
