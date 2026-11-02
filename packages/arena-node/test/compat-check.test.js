// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMPATIBILITY LIST (kanban #926 item 10): a row says "works" only when every check passed, and a product has one row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultRow, withRow, parseNwc } from '../tools/compat-check.mjs';

test('one check that failed is not a working product', () => {
  assert.equal(resultRow({ name: 'A', version: '1', kind: 'NWC wallet', checks: { get_info: 'ok', get_balance: 'ok' } }).result, 'works');
  assert.equal(resultRow({ name: 'A', version: '1', kind: 'NWC wallet', checks: { get_info: 'ok', make_invoice: 'NOT_IMPLEMENTED: no' } }).result, 'problems');
});

test('a new test of a product replaces its row, and the list keeps its order', () => {
  const a = resultRow({ name: 'B', version: '1', kind: 'NWC wallet', checks: { x: 'ok' } });
  const list = withRow(withRow([], a), resultRow({ name: 'A', version: '2', kind: 'Remote signer', checks: { x: 'ok' } }));
  const next = withRow(list, resultRow({ name: 'B', version: '2', kind: 'NWC wallet', checks: { x: 'ok' } }));
  assert.deepEqual(next.map((r) => [r.name, r.version]), [['B', '2'], ['A', '2']]);
});

test('a link that is not a wallet connection is refused', () => {
  assert.throws(() => parseNwc('https://example.com/'));
});
