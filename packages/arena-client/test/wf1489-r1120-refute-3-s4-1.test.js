// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 4), TIMING AT THE DEADLINE #3102 ADDED: lookThePending's ask() ends st.graceMs (200 ms) after
// more than half the round's nodes answered. Two seats of seven (within a 5-of-7 federation's fault bound) that answer at once with
// "not decided" plus the two fastest honest seats make that half; the three other honest seats (seats on other hosts, a few hundred ms
// later) are cut off. The vote is then 2 decided of 4 answered, not more than half, so the owed payout's record is never rebuilt - and
// the same at every later look. Before #3102 (Promise.all) the vote was 5 decided of 7 and the record was rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, writeNote, payout, recordsOf } from './wf1489-r1120-refute-3-s1-harness.js';
import { pageWith } from './wf1489-r1120-refute-3-s2-harness.js';

const later = (ms, body) => new Promise((r) => setTimeout(() => r(body), ms));
const notDecided = { kind: 'payout', pendingMsat: null, provisional: false, state: 'OPEN' };

test('#3086 deadline: two fast seats saying "not decided" do not outvote five honest seats that answer 400-600 ms later', async () => {
  const V = store(), S = store(); const rid = '81'.repeat(32), eid = 'f1'.repeat(32);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  const delay = { 'https://n1': 0, 'https://n2': 0, 'https://n3': 5, 'https://n4': 10, 'https://n5': 400, 'https://n6': 500, 'https://n7': 600 };
  const p = pageWith(V, S, (node) => (node === 'https://n1' || node === 'https://n2' ? later(0, notDecided) : later(delay[node], payout(180000))), {});
  // three looks, each asking afresh (a settled answer is asked again after 30 s; here at once)
  for (let i = 0; i < 3; i++) { if (p.look.st) p.look.st.settledMs = 0; await p.look(); }
  assert.equal(recordsOf(V, rid).length, 1, 'five of seven seats say the payout is owed; the record is rebuilt: ' + p.said.join(' / '));
});
