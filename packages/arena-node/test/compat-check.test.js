// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMPATIBILITY LIST (kanban #926 item 10): a row says "works" only when every check passed, and a product has one row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('nothing checked is never a working product (kanban #2939)', () => {
  assert.equal(resultRow({ name: 'A', version: '1', kind: 'Browser extension', checks: {} }).result, 'problems');
});

test('manual mode without CHECKS writes no row (kanban #2939)', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/compat-check.mjs', import.meta.url)), 'manual', 'nip-07'], { env: { ...process.env, NAME: 'A', VERSION: '1', CHECKS: '' }, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /CHECKS/);
  assert.equal(run.stdout, '');
});

test('a row carries the product address, platform, date and how it was tested (kanban #2917); a bad address or date is refused', () => {
  const r = resultRow({ name: 'Amber', version: '6.6.9', kind: 'Remote signer', checks: { login: 'ok' }, url: 'https://example.com/amber', platform: 'Android', how: 'manual', date: '2026-11-16' });
  assert.deepEqual([r.url, r.platform, r.how, r.date, r.result], ['https://example.com/amber', 'Android', 'manual', '2026-11-16', 'works']);
  assert.equal(resultRow({ name: 'A', version: '1', kind: 'NWC wallet', checks: { x: 'ok' } }).how, 'automatic');
  assert.throws(() => resultRow({ name: 'A', version: '1', kind: 'NWC wallet', checks: { x: 'ok' }, url: 'javascript:alert(1)' }), /URL/);
  assert.throws(() => resultRow({ name: 'A', version: '1', kind: 'NWC wallet', checks: { x: 'ok' }, date: '17.11.2026' }), /DATE/);
});

test('manual mode with KIND=signer writes a remote signer row (kanban #2917)', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/compat-check.mjs', import.meta.url)), 'manual', 'nip-46'],
    { env: { ...process.env, NAME: 'Clave', VERSION: '1.0', KIND: 'signer', CHECKS: 'login=ok', PLATFORM: 'iOS', DATE: '2026-11-17' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const row = JSON.parse(run.stdout);
  assert.deepEqual([row.kind, row.how, row.platform, row.date, row.result], ['Remote signer', 'manual', 'iOS', '2026-11-17', 'works']);
});
