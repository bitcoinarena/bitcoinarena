// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3105 (refute of #3081): a paid record is dropped only while its key still holds the same payment - never another tab's newer one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidRecordPut, paidRecordGet, paidRecordDropIf, paidRecordMark } from '../src/paid-records.js';

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const K = 'arena.purchase.nextblock.large-truck.0011223344556677';

test('#3105 a submitted record is dropped only when the key still holds its txid', () => {
  const st = store();
  const t1 = { submitted: { txid: '11'.repeat(32) }, body: null, mark: paidRecordMark() };
  const t2 = { submitted: { txid: '22'.repeat(32) }, body: null, mark: paidRecordMark() };
  paidRecordPut(st, K, t2);
  paidRecordDropIf(st, K, t1);
  assert.equal(paidRecordGet(st, K).submitted.txid, t2.submitted.txid, 'T1\'s drop left T2 kept');
  paidRecordDropIf(st, K, t2);
  assert.equal(paidRecordGet(st, K), null);
});

test('#3105 a write-ahead (nothing submitted) is dropped only by its own mark', () => {
  const st = store();
  const mine = { submitted: null, body: null, mark: paidRecordMark(), boughtAtMs: '1' };
  const other = { submitted: null, body: null, mark: paidRecordMark(), boughtAtMs: '1' };
  assert.notEqual(mine.mark, other.mark);
  paidRecordPut(st, K, other);
  paidRecordDropIf(st, K, mine);
  assert.equal(paidRecordGet(st, K).mark, other.mark, 'another tab\'s write-ahead stays');
  paidRecordPut(st, K, { ...other, submitted: { txid: '33'.repeat(32) } });
  paidRecordDropIf(st, K, other);
  assert.equal(paidRecordGet(st, K).submitted.txid, '33'.repeat(32), 'the same mark, now paid: a write-ahead drop leaves it');
  paidRecordPut(st, K, mine);
  paidRecordDropIf(st, K, mine);
  assert.equal(paidRecordGet(st, K), null);
});
