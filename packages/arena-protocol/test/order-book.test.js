// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MARKET ORDER BOOK: signed limit orders, one uniform price per batch, fees due at resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify as edVerify } from 'node:crypto';
import { orderId, orderStands, clearBatch, resolveBook, orderNetMsat, bookBatch, BATCH_MS, PRICE_SCALE, YES, NO } from '../src/order-book.js';
import { toHex } from '../src/hash.js';

const ROUND = new Uint8Array(32).fill(7);
const FEE = 100;   // the market default: 0.5 % nodes + 0.5 % donation
const o = (id, outcome, price, sat) => ({ id: id.padStart(64, '0'), outcome, price: BigInt(price), stakeMsat: BigInt(sat) * 1000n });
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
// MONEY IS KEPT: every stake is its refund, its fee and its cost; the pool is every cost, paid whole to the winners
function conserves(orders, fills, res) {
  assert.equal(sum(fills.map((f) => f.refundMsat + f.feeMsat + f.costMsat)), sum(orders.map((x) => x.stakeMsat)), 'a msat of the stakes went nowhere');
  assert.equal(sum(res.rows.map((r) => r.paidMsat)), res.voided ? sum(fills.map((f) => f.costMsat + f.feeMsat)) : res.poolMsat, 'the pool was not paid whole');
}

test('the owner\'s example: 1 sat on Up - 0.01 sat fee, due when it fills; 0.99 sat buys the odds', () => {
  const orders = [o('a', YES, 74000, 1), o('b', NO, 27000, 1)];
  const b = clearBatch({ orders, feeBps: FEE });
  const [yes, no] = b.fills;
  console.log('  BATCH:', JSON.stringify({ price: String(b.price), matched: String(b.matchedMsat), fills: b.fills.map((f) => [f.outcome, String(f.payoutMsat), String(f.costMsat), String(f.feeMsat), String(f.refundMsat)]) }));
  // ONE PRICE: 0.73 for YES (the NO limit 0.27 is the binding one: the most payout matched), so YES pays less than its limit
  assert.equal(b.price, 73000n);
  assert.equal(orderNetMsat(1000n, FEE), 990n);
  // YES spends its whole 0.99 sat: 990 msat buys 990 / 0.73 = 1356 msat of payout, and its fee is the whole 10 msat
  assert.equal(yes.payoutMsat, 1356n);
  assert.equal(yes.feeMsat, 10n);
  assert.equal(yes.refundMsat, 0n);
  // NO, the long side, buys the same 1356 msat of payout at 0.27 = 367 msat; the rest of its stake comes back, its fee on it too
  assert.equal(no.payoutMsat, 1356n);
  assert.equal(no.costMsat, 367n);
  assert.equal(no.feeMsat, (10n * 367n) / 990n);
  assert.ok(no.refundMsat > 600n);
  // RESOLVED YES: YES is paid the whole pool (both costs), the fees fall due on both sides
  const res = resolveBook({ fills: b.fills, outcome: YES });
  assert.equal(res.rows.find((r) => r.id === yes.id).paidMsat, yes.costMsat + no.costMsat);
  assert.equal(res.feesMsat, yes.feeMsat + no.feeMsat);
  conserves(orders, b.fills, res);
});

test('the long side\'s better limit fills first, the marginal limit pro rata, the msat left in id order; nothing crosses: nothing fills', () => {
  const orders = [o('1', YES, 60000, 10), o('2', NO, 50000, 3), o('3', NO, 50000, 3), o('4', NO, 45000, 10)];
  const b = clearBatch({ orders, feeBps: FEE });
  const f = Object.fromEntries(b.fills.map((x) => [x.id.slice(-1), x]));
  console.log('  MARGIN:', JSON.stringify({ price: String(b.price), fills: b.fills.map((x) => [x.id.slice(-1), String(x.payoutMsat), String(x.costMsat)]) }));
  assert.equal(b.fills.filter((x) => x.outcome === YES).reduce((t, x) => t + x.payoutMsat, 0n), b.matchedMsat);
  assert.equal(b.fills.filter((x) => x.outcome === NO).reduce((t, x) => t + x.payoutMsat, 0n), b.matchedMsat);
  // the two equal NO limits are treated alike (within one msat), and the order of the batch does not change a thing
  const d = f['2'].payoutMsat - f['3'].payoutMsat;
  assert.ok(d === 0n || d === 1n);
  assert.deepEqual(clearBatch({ orders: [...orders].reverse(), feeBps: FEE }), b);
  for (const outcome of [YES, NO]) conserves(orders, b.fills, resolveBook({ fills: b.fills, outcome }));
  // NOTHING CROSSES: YES at most 0.40, NO at most 0.50 - no set is funded, every stake comes back whole, no fee
  const none = clearBatch({ orders: [o('5', YES, 40000, 5), o('6', NO, 50000, 5)], feeBps: FEE });
  assert.equal(none.price, null);
  for (const x of none.fills) { assert.equal(x.costMsat + x.feeMsat, 0n); assert.equal(x.refundMsat, 5000n); }
});

test('a VOID market gives every cost and every fee back; an order is its player\'s, signed over its id', () => {
  const orders = [o('a', YES, 70000, 2), o('b', NO, 35000, 2)];
  const b = clearBatch({ orders, feeBps: FEE });
  const v = resolveBook({ fills: b.fills, outcome: null });
  assert.equal(v.feesMsat, 0n);
  for (const r of v.rows) { const f = b.fills.find((x) => x.id === r.id); assert.equal(r.paidMsat + f.refundMsat, f.costMsat + f.feeMsat + f.refundMsat); }
  conserves(orders, b.fills, v);
  // THE SIGNATURE
  const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const order = { roundId: ROUND, playerKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)), outcome: YES, price: 74000n, stakeMsat: 4000n, nonce: 1n };
  order.signature = new Uint8Array(sign(null, Buffer.from(orderId(order)), privateKey));
  const verify = (s, m, k) => edVerify(null, Buffer.from(m), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(k)]), format: 'der', type: 'spki' }), Buffer.from(s));
  assert.equal(orderStands(order, { verify, roundId: ROUND }).ok, true);
  assert.match(orderStands({ ...order, price: 75000n }, { verify }).why, /signature is not its player's/);
  // POLYMARKET'S BOOK: whole cents, at least 5 shares (4 sat at 0.74 less 1 % buys 5.35; 3 sat buys 4.01)
  assert.match(orderStands({ ...order, price: 73999n }, { verify }).why, /a price is a whole tick of 1000 \(0.01\): 73999 is not/);
  assert.match(orderStands({ ...order, stakeMsat: 3000n }, { verify }).why, /at least 5 shares at its limit, and that one buys 4/);
  assert.match(orderStands(order, { verify, roundId: new Uint8Array(32) }).why, /another round/);
  assert.match(orderStands({ ...order, price: PRICE_SCALE }, { verify }).why, /a price is 1 to 99999/);
  assert.equal(toHex(orderId(order)).length, 64);
});

test('standing orders: what has not filled stands into the next batch (every half second) until it fills, is cancelled or expires; one order over several batches is one position', () => {
  assert.equal(BATCH_MS, 500n);
  const t0 = 1791598500000n;
  // BATCH 1: Up 10 sat at 0.60 meets only Down 2 sat at 0.45 - Up fills a little, the rest stands
  const up = o('a', YES, 60000, 10);
  const b1 = bookBatch({ incoming: [up, o('b', NO, 45000, 2)], nowMs: t0, feeBps: FEE });
  const left1 = b1.resting.find((x) => x.id === up.id);
  // BATCH 2, ONE SECOND LATER: a new Down order fills the rest of Up; a GTD order already expired comes back
  const late = { ...o('c', NO, 40000, 20), expiryMs: t0 + 500n };
  const b2 = bookBatch({ resting: b1.resting, incoming: [o('d', NO, 45000, 20), late], nowMs: t0 + BATCH_MS, feeBps: FEE });
  // BATCH 3: what Down 'd' left stands; its player cancels it - back whole, at no cost
  const b3 = bookBatch({ resting: b2.resting, cancels: [o('d', NO, 0 + 45000, 20).id], nowMs: t0 + 2n * BATCH_MS, feeBps: FEE });
  console.log('  STANDING:', JSON.stringify({ b1: [String(b1.price), String(left1.stakeMsat)], b2: [String(b2.price), b2.fills.map((f) => f.id.slice(-1) + ':' + f.payoutMsat), b2.returned.map((r) => r.id.slice(-1) + ':' + r.why)],
    b3: b3.returned.map((r) => `${r.id.slice(-1)}:${r.why}:${r.stakeMsat}`), resting3: b3.resting.length }));
  assert.ok(left1 && left1.stakeMsat > 0n && left1.stakeMsat < up.stakeMsat, 'Up\'s unfilled part did not stand');
  assert.ok(b2.fills.some((f) => f.id === up.id), 'the standing rest did not fill in the next batch');
  assert.deepEqual(b2.returned.map((r) => [r.id.slice(-1), r.why, r.stakeMsat]), [['c', 'expired', 20000n]]);
  assert.equal(b2.resting.some((x) => x.id === up.id), false, 'Up stood on after it filled');
  assert.deepEqual(b3.returned.map((r) => [r.id.slice(-1), r.why]), [['d', 'cancelled']]);
  assert.equal(b3.resting.length, 0);
  // RESOLVED UP: Up's two fills are one position, paid the whole pool; every sat of every stake accounted for
  const fills = [...b1.fills, ...b2.fills];
  const res = resolveBook({ fills, outcome: YES });
  const upRow = res.rows.find((r) => r.id === up.id);
  assert.equal(res.rows.filter((r) => r.id === up.id).length, 1);
  assert.equal(upRow.paidMsat, res.poolMsat);
  const stakes = 10000n + 2000n + 20000n + 20000n;
  const back = [...b2.returned, ...b3.returned].reduce((t, r) => t + r.stakeMsat, 0n);
  assert.equal(fills.reduce((t, f) => t + f.costMsat + f.feeMsat, 0n) + back, stakes, 'a msat of the stakes went nowhere across the batches');
});
