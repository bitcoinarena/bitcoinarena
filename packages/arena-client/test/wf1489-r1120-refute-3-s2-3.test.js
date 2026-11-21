// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 2), THE RETRY PATH: the rebuild's own write is refused (the same full storage that lost the
// join's record - feedback #365's cause). st.rebuilt takes the note's key BEFORE the write, so once room is free again no later look
// tries again: the payout keeps no record for the rest of the tab's life.
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, writeNote, payout, recordsOf } from './wf1489-r1120-refute-3-s1-harness.js';
import { pageWith } from './wf1489-r1120-refute-3-s2-harness.js';

test('#3086 retry: a rebuild refused once for a full storage is tried again at a later look', async () => {
  const V = store(), S = store(); const rid = '73'.repeat(32), eid = 'e9'.repeat(32);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  let full = true; const set = V.setItem;
  V.setItem = (k, v) => { if (full && k.startsWith('arena.collect.')) { const e = new Error('QuotaExceededError: the quota has been exceeded'); e.name = 'QuotaExceededError'; throw e; } return set(k, v); };
  const p = pageWith(V, S, () => payout(180000), {});
  await p.look();
  assert.equal(recordsOf(V, rid).length, 0, 'refused while full');
  full = false;   // room again (a withdraw, another tab freed its lock wallet)
  await p.look(); await p.look();
  assert.equal(recordsOf(V, rid).length, 1, 'rebuilt once there is room: ' + p.said.filter((x) => /rebuil|written/.test(x)).join(' / '));
});
