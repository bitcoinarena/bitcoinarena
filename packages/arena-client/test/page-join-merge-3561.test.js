// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A JOIN COMPLETES A MERGE THAT IS STILL PENDING (kanban #3561, feedback #406/#426/#428, UI 759): the round's federation held 1,205 sat, all in
// another phrase's wallet of this browser still merging in; that wallet "did not open in 10 s", which bars it for 2 minutes (5 for the federation
// after a second miss). On this line the join's "merged first" step asked ARENA_MERGE_NOW for 12 s without lifting those bars, so the barred
// wallet was skipped and the join went on to a refusal. index.html's step, lifted: it asks the merge forced, long enough for a 25 s open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const TEXT = readFileSync(PAGE, 'utf8');
const START = "            if (plan.coveredBy === 'merge' && plan.mergeFirst.length && window.ARENA_MERGE_NOW) {";
const END = "              txStep('<- merge ' + m + ' sat first');\n            }";
const A = TEXT.indexOf(START), B = TEXT.indexOf(END, A) + END.length;

test('the join\'s merge-first step asks the merge forced, with time for a forced open', async () => {
  assert.ok(A > 0 && B > A, 'the page has no merge-first step in its join');
  const asks = [];
  const window = { ARENA_WALLET_BALANCE: { merging: 1205 }, ARENA_MERGE_NOW: async (feds, ms, opts = {}) => { asks.push({ feds, ms, force: !!opts.force }); } };
  const run = new Function('window', 'plan', 'onStep', 'txStep', 'seed', 'wasm', 'here', 'named', `return (async () => {${TEXT.slice(A, B)}})();`);
  await run(window, { coveredBy: 'merge', mergeFirst: ['337ae01a'] }, () => {}, () => {}, new Uint8Array(32), { LockClient: {} }, '337ae01a', { federation: 'inv' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].force, true, 'the merge is asked without lifting the bars on a wallet that did not open');
  assert.ok(asks[0].ms >= 30000, 'the merge is given ' + asks[0].ms + ' ms - less than a forced open (25 s) and its send');
});

test('the merge lifts its bars only when forced', () => {
  assert.ok(TEXT.includes("if (!force && ((mergeNoOpen.get(noOpenKey) || 0) > Date.now()"), 'a forced merge still skips a barred wallet');
  assert.ok(/MERGE_FORCE_OPEN_MS = 25000/.test(TEXT));
});
