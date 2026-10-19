// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORDER BOOK'S LEDGER AND SETTLEMENT (comment 1127, the owner's (a)): pure, so every seat holding the same
// certified batches settles the same - each filled lock claimed whole, every msat of the locks paid out or due as a fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger, bookSettlement, positionFilled } from '../src/book-ledger.js';
import { YES, NO } from '../src/order-book.js';

const FEE = 100;
const id = (s) => s.padStart(64, '0');
// an order: stake in sat, its fee lock 1 % of it (entryFeeMsat), its stake lock the rest
const o = (name, outcome, cents, sat, expiryMs = 0n) => ({ id: id(name), outcome, price: BigInt(cents) * 1000n, stakeMsat: BigInt(sat) * 1000n, feeMsat: BigInt(sat) * 10n, expiryMs });
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
const locksOf = (s) => sum(s.claimed.map((r) => r.stakeMsat + r.feeMsat));

test('a sell passes shares to the buyer; Up and Down both balance to the msat; a sell beyond what is held is refused', () => {
  // BATCH 1: A buys Up (10 sat at 0.60), B buys Down (10 sat at 0.45): A fills
  // BATCH 2: A sells 5 sat of Up at >= 0.70 to C (Up at 0.75); a sell of more than A holds unsold is refused
  const b1 = { k: 1, cutoffMs: 1000n, orders: [o('a', YES, 60, 10), o('b', NO, 45, 10)] };
  const ledger1 = bookLedger({ batches: [b1], feeBps: FEE });
  const aUp = ledger1.positions.get(id('a')).shares[YES];
  const b2 = { k: 2, cutoffMs: 2000n, orders: [o('c', YES, 75, 10)],
    sells: [{ id: id('s1'), entry: id('a'), outcome: YES, price: 70000n, sharesMsat: 5000n }, { id: id('s2'), entry: id('a'), outcome: YES, price: 70000n, sharesMsat: aUp }] };
  const L = bookLedger({ batches: [b1, b2], feeBps: FEE });
  const a = L.positions.get(id('a'));
  const c = L.positions.get(id('c'));
  console.log('  SELL:', JSON.stringify({ aUp: String(aUp), prices: L.batches.map((x) => String(x.price)), a: { up: String(a.shares[0]), down: String(a.shares[1]), debt: String(a.sellDebt), fee: String(a.sellFee) },
    c: { up: String(c.shares[0]), cost: String(c.cost) }, refused: L.refused.map((r) => r.why) }));
  assert.equal(L.refused.length, 1);
  assert.match(L.refused[0].why, /that sell offers .* of outcome 0 and its entry holds .* unsold/);
  assert.equal(a.shares[NO], 5000n, 'the sold shares did not close into sets');
  assert.equal(c.shares[YES] >= 5000n, true, 'the buyer did not get the shares');
  for (const outcome of [YES, NO]) {
    const s = bookSettlement({ positions: L.positions, outcome });
    const outA = s.claimed.find((r) => r.entry === id('a')).outMsat;
    console.log(`  ${outcome === YES ? 'UP' : 'DOWN'}:`, JSON.stringify({ out: s.claimed.map((r) => [r.entry.slice(-2), String(r.outMsat)]), fees: String(s.feesDueMsat), locks: String(locksOf(s)) }));
    assert.equal(sum(s.claimed.map((r) => r.outMsat)) + s.feesDueMsat, locksOf(s), 'the book does not balance');
    // A's 5 sold shares: their proceeds come back whatever wins - the sale's price less its fee, as part of A's out
    if (outcome === NO) assert.ok(outA >= 5000n * 70n / 100n - a.sellFee - 10n, 'the seller lost its proceeds when the shares it sold lost');
  }
});

test('cancels: an unfilled order leaves no position to claim; a partly filled one keeps its fill and gets its rest back at settlement (a); expiry; VOID', () => {
  // BATCH 1: D buys Up 20 sat at 0.50, E buys Down 6 sat at 0.50 - D fills partly; F buys Down 8 sat at 0.30 (no cross)
  const b1 = { k: 1, cutoffMs: 1000n, orders: [o('d', YES, 50, 20), o('e', NO, 50, 6), o('f', NO, 30, 8), o('g', YES, 40, 5, 1500n)] };
  // BATCH 2: D and F cancel; G expired; then H buys Down at 0.60 - nothing of D or G is left to fill
  const b2 = { k: 2, cutoffMs: 2000n, orders: [o('h', NO, 60, 10)], cancels: [id('d'), id('f')] };
  const L = bookLedger({ batches: [b1, b2], feeBps: FEE });
  const d = L.positions.get(id('d'));
  console.log('  CANCEL:', JSON.stringify({ d: { cost: String(d.cost), N: String(d.N), fee: String(d.buyFee), cancelled: d.cancelled, filledBefore: d.filledBeforeCancel },
    fFilled: positionFilled(L.positions.get(id('f'))), b2: String(L.batches[1].price), resting: L.resting }));
  assert.ok(d.cost > 0n && d.cost < d.N, 'D did not fill partly');
  assert.equal(d.filledBeforeCancel, true);
  assert.equal(positionFilled(L.positions.get(id('f'))), false, 'F, cancelled unfilled, holds a position');
  assert.equal(L.batches[1].price, null, 'something of D or G filled after its cancel or expiry');
  assert.deepEqual(L.resting.buys, [id('h')]);
  const s = bookSettlement({ positions: L.positions, outcome: NO });
  const rowD = s.claimed.find((r) => r.entry === id('d'));
  // (a): D's rest of its budget and of its fee come back at settlement, exactly
  assert.equal(rowD.outMsat, (d.N - d.cost) + (d.F - d.buyFee), 'D did not get exactly its unfilled rest back');
  assert.equal(s.claimed.some((r) => r.entry === id('f') || r.entry === id('g') || r.entry === id('h')), false, 'an unfilled order\'s lock was claimed');
  assert.equal(sum(s.claimed.map((r) => r.outMsat)) + s.feesDueMsat, locksOf(s));
  assert.equal(s.feesDueMsat, sum(s.claimed.map((r) => r.buyFeeMsat + r.sellFeeMsat)));
  assert.deepEqual(bookSettlement({ positions: L.positions, outcome: null }), { claimed: [], poolMsat: 0n, feesDueMsat: 0n, voided: true });
});

// A SCALAR MARKET'S BOOK (§0A.7e): a LONG share (0) is worth (V - low) / (high - low) of a sat at the clamped value, a
// SHORT share (1) the rest - the pool split by where V lies, each side pro rata by its shares; every msat paid out or due.
test('a scalar book splits its pool between LONG and SHORT by where the value lies, clamped, to the msat', () => {
  const b1 = { k: 1, cutoffMs: 1000n, orders: [o('a', YES, 60, 10), o('b', NO, 45, 10), o('c', YES, 55, 4), o('d', NO, 50, 6)] };
  const L = bookLedger({ batches: [b1], feeBps: FEE });
  const bounds = { low: 8000000n, high: 9000000n };
  const outs = {};
  for (const [name, value] of [['low', 7000000n], ['quarter', 8250000n], ['mid', 8500000n], ['high', 9999999n]]) {
    const s = bookSettlement({ positions: L.positions, outcome: null, scalar: { value, bounds } });
    assert.equal(sum(s.claimed.map((r) => r.outMsat)) + s.feesDueMsat, locksOf(s), `${name}: the book does not balance`);
    const win = (side) => sum(s.claimed.filter((r) => L.positions.get(r.entry).shares[side] > 0n).map((r) => r.winMsat));
    outs[name] = { long: win(YES), short: win(NO), pool: s.poolMsat };
  }
  console.log('  SCALAR BOOK:', JSON.stringify(Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, [String(v.long), String(v.short), String(v.pool)]]))));
  assert.equal(outs.low.long, 0n, 'at or below low SHORT takes the whole pool');
  assert.equal(outs.low.short, outs.low.pool);
  assert.equal(outs.high.short, 0n, 'at or above high LONG takes the whole pool');
  assert.equal(outs.high.long, outs.high.pool);
  assert.equal(outs.mid.long, outs.mid.pool / 2n, 'the middle splits it in half (LONG floored)');
  assert.equal(outs.quarter.long, outs.quarter.pool / 4n);
  assert.throws(() => bookSettlement({ positions: L.positions, outcome: null, scalar: { value: 1n, bounds: { low: 5n, high: 5n } } }), /between bounds low < high/);
  // the binary book is unchanged by it
  const yes = bookSettlement({ positions: L.positions, outcome: YES });
  assert.equal(sum(yes.claimed.map((r) => r.outMsat)) + yes.feesDueMsat, locksOf(yes));
});

test('the ledger names what stands, priced: each resting buy\'s outcome, limit and rest, each resting sell', () => {
  // A buys Up 10 sat at 0.40 and B Down 10 sat at 0.50: 0.40 + 0.50 < 1, nothing matches, both stand; C buys Up at 0.30 beside them
  const b1 = { k: 1, cutoffMs: 1000n, orders: [o('a', YES, 40, 10), o('b', NO, 50, 10), o('c', YES, 30, 5, 5000n)] };
  const L = bookLedger({ batches: [b1], feeBps: FEE });
  assert.deepEqual(L.levels.buys.map((x) => [x.outcome, String(x.price), String(x.netMsat), String(x.expiryMs)]).sort(),
    [[0, '30000', '4950', '5000'], [0, '40000', '9900', '0'], [1, '50000', '9900', '0']]);
  assert.deepEqual(L.levels.sells, []);
  assert.equal(L.resting.buys.length, 3, 'the ids stay as they were');
  // a fill takes its order out of the levels
  const L2 = bookLedger({ batches: [b1, { k: 2, cutoffMs: 2000n, orders: [o('d', NO, 70, 10)] }], feeBps: FEE });
  assert.ok(!L2.levels.buys.some((x) => x.outcome === 0 && x.price === 40000n && x.netMsat === 9900n), 'a filled buy still stands');
});
