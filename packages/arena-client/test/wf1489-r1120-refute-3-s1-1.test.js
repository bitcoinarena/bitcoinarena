// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086, VARIANT (another kind of owed money): the seats say the round is refunded - every stake comes back
// (standing.js kind 'refund'). The tab holds no collect record (the same refused save). The refund is owed to this seed just as a payout
// is, but #3086 rebuilds only after the payout vote (`best[0] === null` continues first), so the stake keeps no record and no collect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, writeNote, page, refund, recordsOf } from './wf1489-r1120-refute-3-s1-harness.js';

test('#3086 variant: a refunded round\'s stake owed with no collect record gets its record rebuilt too', async () => {
  const V = store(), S = store(); const rid = '6c'.repeat(32), eid = 'c0'.repeat(32);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  const p = page(V, S, { [eid]: refund() });
  await p.look();
  assert.equal(recordsOf(V, rid).length, 1, 'the refunded stake has a collect record (said: ' + (p.said.join(' / ') || 'nothing') + ')');
});
