// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE UNBACKED SPEND (kanban #1093 part 2, ruling #1106): the reserve output the threshold names, spent on the chain 6 deep by a transaction the
// signed history does not name, raises the alarm; the federation's own moves (peg-outs, sweeps, drains) are in the history and pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReserveSpendWatch } from '../src/reserve-spend-watch.js';
import { createReserveAlarms } from '../src/reserve-alarms.js';

const FED = 'ab'.repeat(32), A = 'aa'.repeat(32) + ':0', B = 'bb'.repeat(32) + ':0';
function world() {
  const w = { tip: 1000, wallet: A, spent: new Set(), spender: new Map(), hist: new Set(), readAtMs: 0, now: 1, rows: new Map() };
  const alarms = createReserveAlarms();
  const watch = createReserveSpendWatch({ walletOutpoint: async () => w.wallet, isSpent: async (op) => w.spent.has(op), spenderOf: async (op) => w.spender.get(op) || null,
    historyTxids: async () => ({ txids: w.hist, readAtMs: w.readAtMs }), tip: async () => w.tip, load: (f) => w.rows.get(f) || null, save: (f, r) => w.rows.set(f, r),
    alarms, nowMs: () => w.now });
  return { w, alarms, watch };
}

test('the federation moves its own reserve: the spender is in the signed history, no alarm', async () => {
  const { w, alarms, watch } = world();
  await watch.watchOne(FED);
  w.spent.add(A); w.spender.set(A, { txid: 'bb'.repeat(32), height: 1001 }); w.wallet = B; w.tip = 1001; w.now = 2;
  w.hist.add('bb'.repeat(32));
  const early = await watch.watchOne(FED);
  assert.match(early.results[0].wait, /1 deep, 6 needed/);
  w.tip = 1006; w.readAtMs = 3;
  const r = await watch.watchOne(FED);
  assert.deepEqual(r.results, [{ outpoint: A, consensus: 'bb'.repeat(32) }]);
  assert.equal(alarms.of(FED), null);
});

test('the reserve output is spent by a transaction the signed history never names: after 6 blocks and a fresh read of the history, the alarm', async () => {
  const { w, alarms, watch } = world();
  await watch.watchOne(FED);
  const thief = 'ee'.repeat(32);
  w.spent.add(A); w.spender.set(A, { txid: thief, height: 1003 }); w.tip = 1003; w.now = 5;   // the guardians that stole still name A, or nothing
  await watch.watchOne(FED);
  w.tip = 1008; w.readAtMs = 4;
  assert.match((await watch.watchOne(FED)).results[0].wait, /not read past the spend/, 'a history read before the spend was seen proves nothing');
  w.readAtMs = 6;
  const r = await watch.watchOne(FED);
  assert.deepEqual(r.results, [{ outpoint: A, unbacked: thief }]);
  assert.deepEqual([alarms.of(FED).kind, alarms.of(FED).txid, alarms.of(FED).height], ['unbacked-spend', thief, 1003]);
  assert.deepEqual((await watch.watchOne(FED)).results, [], 'judged once');
});

test('an unspent or unknown output is not judged, and a spend whose spender is not found yet waits', async () => {
  const { w, alarms, watch } = world();
  await watch.watchOne(FED);
  w.wallet = null; w.tip = 1100;
  assert.deepEqual((await watch.watchOne(FED)).results, [], 'the guardians did not answer: A is still unspent, nothing to judge');
  w.spent.add(A); w.tip = 1200;
  assert.deepEqual((await watch.watchOne(FED)).results, [], 'spent, but no spender found in the blocks yet');
  assert.equal(alarms.of(FED), null);
});
