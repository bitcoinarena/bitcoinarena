// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE GRID PLAYED PER WINDOW (§5A.5 the backup rule, kanban #702, 2026-10-26, the owner: "Yes make it part of the design, in the spec"):
// a page offers a paid row only when most of the seats that say so play it in its window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lobbyRowOffered } from '../src/lobby.js';

const drawn = { drawn: { game: ['a'], settlement: ['a'] } };
const row = (said) => ({ free: false, said });

test('a backup row under a drawn primary is not offered; the primary is; a backup is offered once its primary is not drawn', () => {
  // the seats say the backup is not played (its primary is drawn there)
  assert.equal(lobbyRowOffered(row([{ committee: drawn, played: false }, { committee: drawn, played: false }, { committee: drawn, played: true }])), false);
  // the primary, drawn and played
  assert.equal(lobbyRowOffered(row([{ committee: drawn, played: true }, { committee: drawn, played: true }])), true);
  // the primary dead: the backup is played on the seats, and offered
  assert.equal(lobbyRowOffered(row([{ committee: drawn, played: true }, { committee: drawn, played: true }])), true);
  assert.equal(lobbyRowOffered(row([{ committee: { drawn: false, why: 'no committee' }, played: true }])), false);
  // seats older than the rule say nothing of it: as before
  assert.equal(lobbyRowOffered(row([{ committee: drawn }])), true);
  // one seat of three lagging does not hide a played round
  assert.equal(lobbyRowOffered(row([{ committee: drawn, played: false }, { committee: drawn, played: true }, { committee: drawn, played: true }])), true);
});
