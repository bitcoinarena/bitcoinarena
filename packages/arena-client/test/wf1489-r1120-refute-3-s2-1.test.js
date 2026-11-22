// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 2), ATTACKER = ONE SEAT: one of the round's 7 signer nodes accepts GET /standing and never
// answers. lookThePending awaits every node with no timeout (Promise.all over plain fetch), so the look never ends, st.busy stays
// true, and every later look returns at once: the payout the other 6 seats owe never gets its collect record rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, writeNote, payout, recordsOf } from './wf1489-r1120-refute-3-s1-harness.js';
import { pageWith, within } from './wf1489-r1120-refute-3-s2-harness.js';

test('#3086 seat attacker: one hung signer node does not stop the owed payout\'s collect record from being rebuilt', async () => {
  const V = store(), S = store(); const rid = '71'.repeat(32), eid = 'e7'.repeat(32);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  const p = pageWith(V, S, (node) => (node === 'https://n7' ? new Promise(() => {}) : payout(180000)), {});
  const r1 = await within(p.look(), 300);
  const r2 = await within(p.look(), 300);
  assert.equal(recordsOf(V, rid).length, 1, 'the record is rebuilt though one seat hangs (looks: ' + r1 + ', ' + r2 + ')');
});
