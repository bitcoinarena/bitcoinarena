// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1176: THE THEFT ALARM AND THE SPEND WATCH FOLLOW A REORG. A spend is held to its block's hash: a reorg that drops the spending block
// is no longer counted 6 deep, and an alarm raised on it is WITHDRAWN (deposits are offered again). An alarm moves RAISED -> CONFIRMED only on
// the signed word of seated nodes, and only a CONFIRMED one files theft slashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createReserveSpendWatch } from '../src/reserve-spend-watch.js';
import * as alarmsMod from '../src/reserve-alarms.js';

const { createReserveAlarms, alarmRefusal } = alarmsMod;
const FED = 'ab'.repeat(32), A = 'aa'.repeat(32) + ':0', THIEF = 'ee'.repeat(32);
const H = (h, fork = '') => (fork + String(h)).padStart(64, '0');
function world() {
  // the chain: block hashes by height; `fork` names the branch the seat follows now
  const w = { tip: 1000, fork: '', wallet: A, spent: new Set(), spender: new Map(), hist: new Set(), readAtMs: 0, session: 10, now: 1, rows: new Map() };
  const alarms = createReserveAlarms();
  const watch = createReserveSpendWatch({ walletOutpoint: async () => w.wallet, isSpent: async (op) => w.spent.has(op), spenderOf: async (op) => w.spender.get(op) || null,
    historyTxids: async () => ({ txids: w.hist, startedAtMs: w.readAtMs, lastSession: w.session }), tip: async () => w.tip, load: (f) => w.rows.get(f) || null, save: (f, r) => w.rows.set(f, r),
    hashAt: async (h) => (h <= w.tip ? H(h, h >= 1003 ? w.fork : '') : null), alarms, nowMs: () => w.now });
  return { w, alarms, watch };
}
const fid = new Uint8Array(32).fill(0xab);
async function thiefSpendsAt1003(x) {
  const { w, watch } = x;
  await watch.watchOne(FED);
  w.spent.add(A); w.spender.set(A, { txid: THIEF, height: 1003, hash: H(1003) }); w.tip = 1003; w.now = 5;
  await watch.watchOne(FED);
}

test('#1176: the spending block is reorged away after the alarm: the alarm is WITHDRAWN and deposits are offered again', async () => {
  const x = world(); const { w, alarms, watch } = x;
  await thiefSpendsAt1003(x);
  w.tip = 1008; w.readAtMs = 6; await watch.watchOne(FED); w.session = 11;
  assert.deepEqual((await watch.watchOne(FED)).results, [{ outpoint: A, unbacked: THIEF }]);
  assert.equal(alarms.of(FED).state, 'RAISED');
  assert.match(alarmRefusal(alarms, { stakeMsat: 1000n, federationId: fid }), /mark of theft/);
  // a heavier branch from 1003 on: the thief's transaction is in none of its blocks, A is unspent again
  w.fork = 'f'; w.tip = 1010; w.spent.delete(A); w.spender.delete(A); w.now = 9;
  const r = await watch.watchOne(FED);
  const after = alarms.of(FED);
  console.log(`#1176 after the reorg of block 1003: alarm ${after ? after.state : 'none standing'} (held: ${alarms.stateOf(FED)}), deposit refusal: ${alarmRefusal(alarms, { stakeMsat: 1000n, federationId: fid }) || 'none'}`);
  assert.deepEqual(r.results, [{ outpoint: A, reorged: THIEF, height: 1003 }]);
  assert.equal(after, null, 'no standing alarm');
  assert.equal(alarms.stateOf(FED), 'WITHDRAWN');
  assert.match(alarms.held(FED).withdrawn, /spending block 1003 .* left this seat's chain/);
  assert.equal(alarmRefusal(alarms, { stakeMsat: 1000n, federationId: fid }), null, 'deposits are offered again');
  assert.ok(A in w.rows.get(FED).seen && !w.rows.get(FED).spends[A], 'the outpoint is watched again, its dropped spend gone');
});

test('#1176: a reorg before the judgment: the dropped spend is not counted 6 deep, nothing is raised', async () => {
  const x = world(); const { w, alarms, watch } = x;
  await thiefSpendsAt1003(x);
  w.fork = 'f'; w.tip = 1008; w.readAtMs = 6; w.session = 12;     // the branch replaced 1003..1008 while the spend waited for depth
  w.spent.delete(A); w.spender.delete(A);                            // and the thief's transaction is in none of its blocks
  const r = await watch.watchOne(FED);
  w.session = 13; w.tip = 1009; w.now = 7;                           // the history read on, past the session open at the sighting
  await watch.watchOne(FED);
  console.log(`#1176 reorg before 6 deep: first pass ${JSON.stringify(r.results.map((x) => Object.keys(x).filter((k) => k !== 'outpoint')[0]))}, after the history moved on: alarm ${alarms.of(FED) ? `${alarms.of(FED).state} on ${alarms.of(FED).txid.slice(0, 8)}` : 'none'}`);
  assert.equal(alarms.of(FED), null, 'height arithmetic alone said 6 deep; the block is not on this chain');
  assert.deepEqual(r.results.map((x) => Object.keys(x).sort().join()), ['height,outpoint,reorged']);
});

test('#1176: the alarm states: RAISED -> CONFIRMED only on seated nodes\' valid signatures; an inflation is never withdrawn; withdrawn can be raised again', () => {
  const sk = (n) => { const b = new Uint8Array(32); b[0] = 9; b[31] = n; return b; };
  const pkHex = (n) => Buffer.from(schnorr.getPublicKey(sk(n))).toString('hex');
  const seated = new Set([pkHex(1), pkHex(2), pkHex(3)]);
  let saved = [];
  const mine = createReserveAlarms({ me: pkHex(1), verify: (s, m, k) => schnorr.verify(s, m, k), isSeat: (h) => seated.has(h), confirmSeats: 3, save: (all) => { saved = all; } });
  mine.raise({ federation: FED, kind: 'unbacked-spend', height: 1003, txid: THIEF });
  const statementOf = (n, a = mine.held(FED)) => ({ node: pkHex(n), alarm: { ...a, sig: Buffer.from(schnorr.sign(alarmsMod.alarmDigest(a), sk(n))).toString('hex') } });
  const other = { ...mine.held(FED), txid: 'dd'.repeat(32) };
  const forged = { node: pkHex(2), alarm: { ...mine.held(FED), sig: 'ab'.repeat(64) } };
  assert.match(mine.confirm(FED, [statementOf(9), statementOf(2, other), forged]).why, /1 of 3 seats signed/, 'an unseated node, another mark and a bad signature count for nothing');
  assert.match(mine.confirm(FED, [statementOf(2), statementOf(2)]).why, /2 of 3/, 'one node counts once');
  const c = mine.confirm(FED, [statementOf(2), statementOf(3)]);
  assert.deepEqual([c.ok, c.alarm.state, c.alarm.confirmedBy.length], [true, 'CONFIRMED', 3]);
  assert.equal(saved[0].state, 'CONFIRMED', 'kept before it is answered');
  assert.equal(createReserveAlarms({ load: () => saved }).stateOf(FED), 'CONFIRMED', 'across a restart');
  assert.equal(alarmsMod.alarmStep(c.alarm, { kind: 'confirm', by: [], n: 1 }).ok, false, 'confirmed once');
  assert.equal(mine.withdraw({ federation: FED, txid: 'dd'.repeat(32) }).ok, false, 'only by its own spend');
  assert.equal(mine.withdraw({ federation: FED, txid: THIEF, why: 'reorg' }).ok, true, 'a CONFIRMED spend is withdrawn by its reorg too');
  assert.equal(mine.raise({ federation: FED, kind: 'unbacked-spend', height: 1011, txid: 'cc'.repeat(32) }).kept, true, 'a new mark after the withdrawal');
  assert.deepEqual(mine.held(FED).withdrawnBefore, [THIEF]);
  const inf = createReserveAlarms();
  inf.raise({ federation: FED, kind: 'inflation', height: 9, session: 4 });
  assert.match(inf.withdraw({ federation: FED, txid: THIEF }).why, /signed sessions/);
  assert.equal(inf.of(FED).state, 'RAISED');
});
