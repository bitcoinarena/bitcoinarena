// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 3), "ANOTHER TAB" - named in #3086's own comment: lookThePending reads only the notes this tab
// wrote (sessionStorage arena.pending.mine) once it wrote one, and the #3086 rebuild sits inside that loop. Tab A joined round R, its
// record was refused, tab A was closed; tab B (which joined another round, and keeps its sessionStorage across reloads) never reads A's
// note, so A's owed payout is never rebuilt in B however long it stays open.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { store, writeNote, page, payout, recordsOf, round, NODES, SEED } from './wf1489-r1120-refute-3-s1-harness.js';

test('#3086 another tab: a closed tab\'s owed payout with no record is rebuilt by the tab still open', async () => {
  const V = store(), S = store();
  const ridA = '3a'.repeat(32), eidA = 'a1'.repeat(32), ridB = '3b'.repeat(32), eidB = 'b1'.repeat(32);
  writeNote(V, S, { roundIdHex: ridA, entryIdHex: eidA, mine: false });   // tab A's note (A is closed)
  PL.saveCollect(V, { roundIdHex: ridB, round, invite: 'joininvite', nodes: NODES, seed: SEED });   // tab B's own round, kept
  writeNote(V, S, { roundIdHex: ridB, entryIdHex: eidB });   // tab B's own note: its mine list
  const p = page(V, S, { [eidA]: payout(180000), [eidB]: payout(90000) });
  await p.look();
  assert.equal(recordsOf(V, ridA).length, 1, 'tab A\'s owed payout gets its record: ' + p.said.join(' / '));
});
