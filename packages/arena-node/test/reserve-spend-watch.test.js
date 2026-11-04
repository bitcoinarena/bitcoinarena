// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE UNBACKED SPEND (kanban #1093 part 2, ruling #1106): the reserve output the threshold names, spent on the chain 6 deep by a transaction the
// signed history does not name, raises the alarm; the federation's own moves (peg-outs, sweeps, drains) are in the history and pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReserveSpendWatch, spendWatchReads } from '../src/reserve-spend-watch.js';
import { createReserveAlarms } from '../src/reserve-alarms.js';

const FED = 'ab'.repeat(32), A = 'aa'.repeat(32) + ':0', B = 'bb'.repeat(32) + ':0';
function world() {
  const w = { tip: 1000, wallet: A, spent: new Set(), spender: new Map(), hist: new Set(), readAtMs: 0, session: 10, now: 1, rows: new Map() };
  const alarms = createReserveAlarms();
  const watch = createReserveSpendWatch({ walletOutpoint: async () => w.wallet, isSpent: async (op) => w.spent.has(op), spenderOf: async (op) => w.spender.get(op) || null,
    historyTxids: async () => ({ txids: w.hist, startedAtMs: w.readAtMs, lastSession: w.session }), tip: async () => w.tip, load: (f) => w.rows.get(f) || null, save: (f, r) => w.rows.set(f, r),
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
  assert.match((await watch.watchOne(FED)).results[0].wait, /session open when the spend was seen is not in the history yet \(read to 10, past 10 needed\)/);
  w.session = 11;
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

// THE SEAT'S WIRING (kanban #1108, server.js ARENA_RESERVE_SPEND_WATCH=1): the output from a threshold of guardians, spent and spender from the
// seat's chain client, the signed txids from the reserve audit's row - a rogue spend raises the alarm through exactly these reads
test('the seat\'s reads: guardians name the output, the chain client finds its spender, the audit row is the history; a rogue spend raises the alarm', async () => {
  const thief = 'ee'.repeat(32), A_TXID = 'aa'.repeat(32);
  const w = { tip: 500, utxo: new Map([[A, { sats: 10n }]]), blocks: new Map(), audit: { pegOutTxids: ['cc'.repeat(32)], startedAtMs: 0, lastSession: 40 }, now: 1, rows: new Map() };
  const asked = [];
  const reads = spendWatchReads({
    endpointsOf: async () => new Map([[0, 'ws://g0'], [1, 'ws://g1'], [2, 'ws://g2'], [3, 'ws://g3']]),
    readReserve: async ({ endpoints, threshold }) => { asked.push([endpoints.length, threshold]); return { ok: true, reserveSats: 10n, outpoint: A.toUpperCase().replace(':0', ':0') }; },
    thresholdOf: (n) => n - Math.floor((n - 1) / 3),
    chainTxOut: async (t, v) => w.utxo.get(`${t}:${v}`) || null,
    chainSpenderOf: async (t, v, from, to) => { for (let h = from; h <= to; h++) { const s = w.blocks.get(h); if (s && s.spends === `${t}:${v}`) return { txid: s.txid, height: h }; } return null; },
    auditRow: () => w.audit, maxBlocks: 50 });
  assert.equal(await reads.walletOutpoint(FED), A, 'the output a threshold names, lower case');
  assert.deepEqual(asked, [[4, 3]]);
  assert.equal(await reads.isSpent(A), false);
  const alarms = createReserveAlarms();
  const watch = createReserveSpendWatch({ ...reads, tip: async () => w.tip, load: (f) => w.rows.get(f) || null, save: (f, r) => w.rows.set(f, r), alarms, nowMs: () => w.now });
  await watch.watchOne(FED);
  // a threshold spends A outside consensus at 503; the chain client sees it gone from the UTXO set and finds the spender in block 503
  w.utxo.delete(A); w.blocks.set(503, { spends: `${A_TXID}:0`, txid: thief }); w.tip = 503; w.now = 2;
  assert.equal(await reads.isSpent(A), true);
  assert.deepEqual(await reads.spenderOf(A, 500, 503), { txid: thief, height: 503 });
  await watch.watchOne(FED);
  w.tip = 508; w.audit = { ...w.audit, startedAtMs: 3 };   // 6 deep, and an audit pass started after the spend was seen
  assert.match((await watch.watchOne(FED)).results[0].wait, /not in the history yet/);
  w.audit = { ...w.audit, startedAtMs: 4, lastSession: 41 };   // and a later pass read a session past it
  const r = await watch.watchOne(FED);
  assert.deepEqual(r.results, [{ outpoint: A, unbacked: thief }]);
  assert.deepEqual([alarms.of(FED).kind, alarms.of(FED).txid, alarms.of(FED).height], ['unbacked-spend', thief, 503]);
});

test('the seat\'s reads: no endpoints, a stock-wallet federation (no outpoint) or no agreement name no output; the spender search is bounded', async () => {
  const base = { thresholdOf: () => 1, chainTxOut: async () => null, auditRow: () => null };
  assert.equal(await spendWatchReads({ ...base, endpointsOf: async () => null, readReserve: async () => { throw new Error('not asked'); } }).walletOutpoint(FED), null);
  assert.equal(await spendWatchReads({ ...base, endpointsOf: async () => new Map([[0, 'ws://g']]), readReserve: async () => ({ ok: true, reserveSats: 5n, outpoint: null }) }).walletOutpoint(FED), null);
  assert.equal(await spendWatchReads({ ...base, endpointsOf: async () => new Map([[0, 'ws://g']]), readReserve: async () => ({ ok: false }) }).walletOutpoint(FED), null);
  let range = null;
  await spendWatchReads({ ...base, endpointsOf: async () => null, readReserve: null, maxBlocks: 10, chainSpenderOf: async (t, v, f, to) => { range = [t, v, f, to]; return null; } }).spenderOf(A, 100, 500);
  assert.deepEqual(range, ['aa'.repeat(32), 0, 491, 500]);
  assert.deepEqual(await spendWatchReads(base).historyTxids(FED), { txids: new Set(), startedAtMs: 0, lastSession: null });
});

test('the federation\'s own move is never a mark while the session that signed it is still open (kanban #1108, measured 2026-11-04 09:57Z)', async () => {
  // as on the devnet: the consolidation spends A at 1001; the audit passes that start after the sighting read session 10 only - the
  // `Signatures` item is in session 11, still open; 6 deep comes first. The old rule (read after the sighting) raised a false alarm here.
  const { w, alarms, watch } = world();
  await watch.watchOne(FED);
  const own = 'bb'.repeat(32);
  w.spent.add(A); w.spender.set(A, { txid: own, height: 1001 }); w.wallet = B; w.tip = 1001; w.now = 2;
  await watch.watchOne(FED);
  w.tip = 1006; w.readAtMs = 3;                       // 6 deep; a pass started after the sighting, read to 10
  assert.match((await watch.watchOne(FED)).results[0].wait, /not in the history yet/);
  w.readAtMs = 4;                                     // another pass, session 11 not finished yet
  assert.match((await watch.watchOne(FED)).results[0].wait, /not in the history yet/);
  assert.equal(alarms.of(FED), null, 'no alarm while the signing session may be unread');
  w.session = 11; w.hist.add(own); w.readAtMs = 5;    // session 11 finished and read: it names the consolidation
  assert.deepEqual((await watch.watchOne(FED)).results, [{ outpoint: A, consensus: own }]);
  assert.equal(alarms.of(FED), null);
});
