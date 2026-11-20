// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086, the ORIGINAL case and the honest path: a payout the seats owe, no collect record -> rebuilt once,
// as the join would have written it; a record already kept is not touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { store, writeNote, page, payout, recordsOf, round, NODES, SEED } from './wf1489-r1120-refute-3-s1-harness.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#3086 original: FINAL DELIVERED 180000 msat at 7 of 7, no collect record -> the record is rebuilt from the note', async () => {
  const V = store(), S = store(); const rid = '67'.repeat(32), eid = 'e1'.repeat(32);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  const p = page(V, S, { [eid]: payout(180000) });
  await p.look();
  const r = recordsOf(V, rid);
  assert.equal(r.length, 1, 'one record rebuilt: ' + p.said.join(' / '));
  assert.equal(toHex(encodeRoundContract(r[0].round)), toHex(encodeRoundContract(round)), 'the same contract');
  assert.deepEqual(r[0].nodes, NODES); assert.equal(r[0].invite, 'fed1invite'); assert.equal(r[0].order, 0); assert.equal(r[0].done, null);
  assert.equal(p.win.ARENA_PENDING_SATS, 180, 'the pending line still counts it');
});

test('#3086 honest path: a record the join kept (with its lock) is not rewritten', async () => {
  const V = store(), S = store(); const rid = '68'.repeat(32), eid = 'e2'.repeat(32);
  PL.saveCollect(V, { roundIdHex: rid, round, invite: 'joininvite', nodes: NODES, seed: SEED });
  const before = [...V._m.entries()].filter(([k]) => k.startsWith('arena.collect.'));
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid });
  const p = page(V, S, { [eid]: payout(180000) });
  await p.look(); await p.look();
  const after = [...V._m.entries()].filter(([k]) => k.startsWith('arena.collect.'));
  assert.deepEqual(after, before);
});
