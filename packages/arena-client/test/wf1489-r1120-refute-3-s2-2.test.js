// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 2), ATTACKER = A STRANGER'S SEATS: the tab also staked in a round whose signer nodes the
// stranger runs. They answer /standing { kind: 'payout', pendingMsat: 'x' }; that figure wins the vote and BigInt('x') throws out of
// the loop (outside any try), so every look ends at that note and the notes after it - an honest round the seats owe, with no
// collect record - are never reached: no rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, writeNote, payout, recordsOf } from './wf1489-r1120-refute-3-s1-harness.js';
import { pageWith, within } from './wf1489-r1120-refute-3-s2-harness.js';

test('#3086 stranger: a round whose seats answer a bad figure does not stop another round\'s owed payout from being rebuilt', async () => {
  const V = store(), S = store();
  const bad = { rid: 'ba'.repeat(32), eid: 'bb'.repeat(32) }, good = { rid: '72'.repeat(32), eid: 'e8'.repeat(32) };
  writeNote(V, S, { roundIdHex: bad.rid, entryIdHex: bad.eid });
  writeNote(V, S, { roundIdHex: good.rid, entryIdHex: good.eid });
  const p = pageWith(V, S, (node, e) => (e === bad.eid ? { kind: 'payout', pendingMsat: 'x', state: 'FINAL' } : payout(180000)), {});
  const r1 = await within(p.look(), 1000);
  const r2 = await within(p.look(), 1000);
  assert.equal(recordsOf(V, good.rid).length, 1, 'the honest round\'s record is rebuilt (looks: ' + r1 + ', ' + r2 + ')');
});
