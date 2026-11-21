// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3014 (audit entry r1-1): one seat answering ATTESTED with an empty table and a 0-share /book position made the market page mark a pick
// `unfilled`, and index.html refundOrderKeys() took that alone as "its stake is its whole refund": the order's collect record was closed
// "payout: none" once its stake came back, and a won payout was never collected. Safe: `unfilled` counts only beside this page's own VERIFIED
// final outcome of the round whose table has no row for the order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const R = 'f9'.repeat(32), ME = 'aa'.repeat(32);
const keysWith = (outcome, pick = { roundIdHex: R, entryIdHex: ME, unfilled: true, order: { index: 0 } }) => {
  const store = { 'arena.market.picks': JSON.stringify([pick]) };
  const window = { sessionStorage: { getItem: (k) => store[k] ?? null }, ARENA_MARKET_LINES: () => [], ARENA_MARKET_OUTCOMES: new Map(outcome ? [[R, outcome]] : []) };
  const text = readFileSync(PAGE, 'utf8'), from = text.indexOf('    const orderKeyOf = (r) =>');
  const f = new Function('window', text.slice(from, text.indexOf('    const unfilledPickKeys', from)) + '\nreturn refundOrderKeys;');
  return [...f(window)()];
};

test('#3014 a pick marked unfilled on one seat\'s unverified answer is not refund-only', () => {
  // the liar's answer as the market page keeps it: ATTESTED, empty table, no attestation (no check)
  assert.deepEqual(keysWith({ state: 'ATTESTED', final: true, table: { rows: [] } }), [], 'one seat\'s unverified ATTESTED table');
  assert.deepEqual(keysWith(null), [], 'no outcome read yet');
  assert.deepEqual(keysWith({ state: 'ATTESTED', final: true, check: { verified: true }, table: { rows: [{ entryId: ME }] } }), [], 'the verified table holds the order: it was filled');
});

test('#3014 control: an unfilled pick beside a verified final table without its row is refund-only, as #3009 had it', () => {
  assert.deepEqual(keysWith({ state: 'ATTESTED', final: true, check: { verified: true }, table: { rows: [{ entryId: 'bb'.repeat(32) }] } }), [`${R}:0`]);
});
