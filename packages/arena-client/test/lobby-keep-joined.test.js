// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND PLAY CHOSE STAYS THE ROW OF ITS KIND (2026-10-02: "once a round has been selected with play the
// highlighting may no longer change when the other round is newer").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lobbyKeepJoined } from '../src/lobby.js';

const free = { id: 'f1', free: true }, paidNext = { id: 'p2', free: false }, paidJoined = { id: 'p1', free: false };
const rows = [free, paidJoined, paidNext];

test('the joined paid round replaces the newer pick of its kind; the free row is untouched', () => {
  assert.deepEqual(lobbyKeepJoined([free, paidNext], rows, 'p1').map((r) => r.id), ['f1', 'p1']);
});
test('nothing joined, or the joined round no longer listed: the pick stands', () => {
  assert.deepEqual(lobbyKeepJoined([free, paidNext], rows, null).map((r) => r.id), ['f1', 'p2']);
  assert.deepEqual(lobbyKeepJoined([free, paidNext], rows, 'gone').map((r) => r.id), ['f1', 'p2']);
});
test('a joined round of a kind the pick lacks is added', () => {
  assert.deepEqual(lobbyKeepJoined([free], rows, 'p1').map((r) => r.id), ['f1', 'p1']);
});
