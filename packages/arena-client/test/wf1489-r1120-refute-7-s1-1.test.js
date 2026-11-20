// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087 (#3095): a lost deposit found at the federation and claimed already gets its 'deposit' history row
// (scanLostDeposits -> depositEnded -> depositRowOnce, key dep-op-<operation>), and onClaimed fires only when that row was written.
// The page's onClaimed (index.html, #3087) wrote a second plus row, 'returned', for the same sat: the history showed the deposit twice
// (+589 deposit, +589 returned). The page's own onClaimed handler is cut from index.html and run here with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanLostDeposits, recordReceived, ledgerRows } from '../src/page-lock.js';

const PLUS = new Set(['deposit', 'winnings', 'refund', 'returned', 'slash-payout', 'moved-in', 'swapped-in', 'referral', 'zap-in']);
test('#3087 refute: a claimed lost deposit is one plus row in the history, not two', async () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = page.indexOf('ARENACLIENT.scanLostDeposits({');
  assert.ok(at > 0, 'the page call');
  const start = page.indexOf('onClaimed: (d) => {', at);
  assert.ok(start > at, 'the page onClaimed');
  let depth = 0, end = -1;
  for (let i = page.indexOf('{', start); i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  const handlerSrc = page.slice(start + 'onClaimed: '.length, end);
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const k = 'ab'.repeat(32);
  const window = { ARENA_MONEY_ALERT: { credited: () => {} } };
  const onClaimed = new Function('k', 'window', 'ARENACLIENT', 'vault', 'console', `return ${handlerSrc};`)(k, window, { recordReceived }, () => st, { log: () => {} });
  const client = { scanDeposits: async () => JSON.stringify({ next: '0', done: true, found: [{ operation: 'op1', msat: '589000' }] }), awaitReceive: async () => 'Claimed' };
  const r = await scanLostDeposits({ client, storage: st, federationId: k, lost: [], onClaimed });
  assert.equal(r.msat, 589000n, 'what the federation credited');
  const rows = ledgerRows(st, k);
  const plusMsat = rows.filter((x) => PLUS.has(x.kind)).reduce((n, x) => n + BigInt(x.msat), 0n);
  assert.deepEqual(rows.map((x) => x.kind).sort(), ['deposit'], 'one row for the one claimed deposit; got ' + JSON.stringify(rows.map((x) => [x.kind, x.msat])));
  assert.equal(plusMsat, 589000n, 'the history adds what came in once');
});
