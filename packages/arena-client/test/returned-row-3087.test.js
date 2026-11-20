// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3087 (feedback #368): sat the wallet fetched back (Rescan's reissue, a lost deposit claimed) is a history row, once per operation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordReceived, ledgerRows } from '../src/page-lock.js';

test('#3087: a returned credit is a history row; the same operation twice is one row; an unknown kind writes none', () => {
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const fed = 'ab'.repeat(32);
  recordReceived(st, fed, { kind: 'returned', msat: 589000n, outpoint: 'op1' });
  recordReceived(st, fed, { kind: 'returned', msat: 589000n, outpoint: 'op1' });
  recordReceived(st, fed, { kind: 'returned', msat: 12000n });
  recordReceived(st, fed, { kind: 'free-money', msat: 1n });
  const rows = ledgerRows(st, fed);
  assert.deepEqual(rows.map((r) => [r.kind, r.msat]).sort(), [['returned', '12000'], ['returned', '589000']]);
});
