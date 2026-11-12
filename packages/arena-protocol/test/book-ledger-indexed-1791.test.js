// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1722, #1791: the indexed bookLedger answers what the ledger over clearBatch answered (85f803d70, kept here as the reference),
// to the msat and in the same order - positions, every batch's fills, the refused, what rests and the levels - on random books with
// buys, sells (partly filled, too large, twice), cancels and expiries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger } from '../src/book-ledger.js';
import { clearBatch, YES, NO, PRICE_SCALE } from '../src/order-book.js';

const byIdOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function referenceLedger({ batches, feeBps }) {
  const positions = new Map();
  const buys = new Map();               // entry -> its resting buy (the rest of its budget)
  const sells = new Map();              // sell id -> its resting sell (the rest of its shares)
  // EVERY SELL ONCE (kanban #1150): a signed sell carried by a later batch too was set again at its full size - one signature, two sales
  const seenSells = new Set();
  const refused = [];
  const out = [];
  const position = (o) => {
    if (!positions.has(o.id)) {
      const N = o.stakeMsat - o.feeMsat;
      positions.set(o.id, { entry: o.id, outcome: o.outcome, N, F: o.feeMsat, cost: 0n, buyFee: 0n, shares: [0n, 0n],
        sellDebt: 0n, sellFee: 0n, cancelled: false, filledBeforeCancel: false });
    }
    return positions.get(o.id);
  };
  for (const b of batches) {
    // 1. NEW ORDERS
    for (const o of [...(b.orders || [])].sort((x, y) => byIdOrder(x.id, y.id))) {
      if (positions.has(o.id)) { refused.push({ id: o.id, why: 'that order is in the book already' }); continue; }
      const p = position(o);
      buys.set(o.id, { id: o.id, outcome: o.outcome, price: o.price, stakeMsat: o.stakeMsat, net: p.N, fullNet: p.N, fullFee: p.F, expiryMs: o.expiryMs || 0n });
    }
    // 2. CANCELS: the order's rest leaves the book - its buy's and its resting sells' (kanban #591, from the Polymarket comparison:
    // a sell stood until it filled or the window closed; Polymarket cancels any open order) - what filled stays its position
    for (const e of [...(b.cancels || [])].sort(byIdOrder)) {
      const p = positions.get(e);
      if (!p) { refused.push({ id: e, why: 'a cancel of an order the book does not hold' }); continue; }
      buys.delete(e);
      for (const [sid, x] of [...sells]) if (x.entry === e) sells.delete(sid);
      if (!p.cancelled) { p.cancelled = true; p.filledBeforeCancel = p.cost > 0n || p.sellDebt > 0n; }
    }
    // 3. EXPIRY
    for (const [id, o] of buys) if (o.expiryMs > 0n && o.expiryMs <= b.cutoffMs) buys.delete(id);
    // 4. SELLS: no more than its entry holds and has not already offered
    for (const s of [...(b.sells || [])].sort((x, y) => byIdOrder(x.id, y.id))) {
      const p = positions.get(s.entry);
      if (!p) { refused.push({ id: s.id, why: 'a sell of an entry the book does not hold' }); continue; }
      if (seenSells.has(s.id)) { refused.push({ id: s.id, why: 'that sell is in the book already: a signed sell is sold once' }); continue; }
      seenSells.add(s.id);
      const offered = [...sells.values()].filter((x) => x.entry === s.entry && x.outcome === s.outcome).reduce((t, x) => t + x.sharesMsat, 0n);
      const unsold = p.shares[s.outcome] - p.shares[1 - s.outcome] - offered;
      if (s.sharesMsat > unsold) { refused.push({ id: s.id, why: `that sell offers ${s.sharesMsat} of outcome ${s.outcome} and its entry holds ${unsold > 0n ? unsold : 0n} unsold` }); continue; }
      sells.set(s.id, { ...s, sell: true });
    }
    // 5. THE CLEAR
    const cleared = clearBatch({ orders: [...buys.values(), ...sells.values()], feeBps });
    // 6. THE FILLS
    const fills = cleared.fills.filter((f) => f.payoutMsat > 0n);
    for (const f of cleared.fills) {
      if (f.sell) {
        const s = sells.get(f.id);
        if (f.payoutMsat > 0n) {
          const p = positions.get(s.entry);
          p.shares[f.outcome] += f.payoutMsat; p.sellDebt += f.costMsat; p.sellFee += f.feeMsat;
        }
        if (f.restSharesMsat > 0n) sells.set(f.id, { ...s, sharesMsat: f.restSharesMsat }); else sells.delete(f.id);
        continue;
      }
      const p = positions.get(f.id);
      if (f.payoutMsat > 0n) { p.shares[f.outcome] += f.payoutMsat; p.cost += f.costMsat; }
      const o = buys.get(f.id);
      if (f.restNetMsat > 0n) buys.set(f.id, { ...o, net: f.restNetMsat }); else buys.delete(f.id);
    }
    out.push({ k: b.k, price: cleared.price, fills });
  }
  // THE FEE A BUY OWES: its fee lock's share of what its fills spent, F x cost / N - the same over one batch or many
  for (const p of positions.values()) p.buyFee = p.N === 0n ? 0n : (p.F * p.cost) / p.N;
  // WHAT STANDS, PRICED (2026-10-17: "a real desktop view with complete order book bids ask, chart, depth"): each
  // resting buy's outcome, limit and the rest of its budget, each resting sell's outcome, price and unsold shares - the book a page
  // draws, no id and no entry named
  const levels = { buys: [...buys.values()].map((o) => ({ outcome: o.outcome, price: o.price, netMsat: o.net, expiryMs: o.expiryMs || 0n })),
    sells: [...sells.values()].map((x) => ({ outcome: x.outcome, price: x.price, sharesMsat: x.sharesMsat })) };
  return { positions, batches: out, refused, resting: { buys: [...buys.keys()], sells: [...sells.keys()] }, levels };
}

const show = (L) => JSON.stringify({ ...L, positions: [...L.positions] }, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function randomBook(r, { nb, ticks }) {
  const id = (p, n) => (p + n.toString(16)).padStart(64, '0');
  const price = () => (ticks ? BigInt(1 + Math.floor(r() * 99)) * 1000n : BigInt(1 + Math.floor(r() * Number(PRICE_SCALE - 1n))));
  const entries = [];
  let ns = 0;
  const batches = [];
  for (let k = 0; k < nb; k++) {
    const orders = [], sells = [], cancels = [];
    const no = Math.floor(r() * 4);
    for (let i = 0; i < no; i++) {
      const e = id('a', entries.length); entries.push(e);
      const sat = BigInt(1 + Math.floor(r() * 500));
      orders.push({ id: e, outcome: r() < 0.5 ? YES : NO, price: price(), stakeMsat: sat * 1000n, feeMsat: r() < 0.1 ? 0n : sat * 10n,
        expiryMs: r() < 0.2 ? BigInt(k + 1 + Math.floor(r() * 5)) * 500n : 0n });
    }
    if (entries.length && r() < 0.1) orders.push({ id: entries[Math.floor(r() * entries.length)], outcome: YES, price: 50000n, stakeMsat: 1000n, feeMsat: 0n, expiryMs: 0n });
    const nsell = Math.floor(r() * 12);
    for (let i = 0; i < nsell && entries.length; i++) {
      const e = entries[Math.floor(r() * entries.length)];
      const sid = r() < 0.05 && ns ? id('5e', Math.floor(r() * ns)) : id('5e', ns++);
      sells.push({ id: sid, entry: r() < 0.05 ? id('ff', i) : e, outcome: r() < 0.5 ? YES : NO, price: price(), sharesMsat: BigInt(1 + Math.floor(r() * (r() < 0.5 ? 50 : 400000))) });
    }
    if (entries.length && r() < 0.15) cancels.push(entries[Math.floor(r() * entries.length)]);
    if (r() < 0.03) cancels.push(id('cc', k));
    batches.push({ k, cutoffMs: BigInt(k + 1) * 500n, orders, cancels, sells });
  }
  return batches;
}

test('kanban #1791: the indexed ledger is the ledger over clearBatch, on 400 random books', () => {
  let fills = 0, sold = 0, rest = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const batches = randomBook(r, { nb: 5 + Math.floor(r() * 30), ticks: seed % 3 !== 0 });
    const feeBps = [0, 100, 250][seed % 3];
    let want, got, wantErr = null, gotErr = null;
    try { want = show(referenceLedger({ batches, feeBps })); } catch (e) { wantErr = e.message; }
    try { got = show(bookLedger({ batches, feeBps })); } catch (e) { gotErr = e.message; }
    assert.equal(gotErr, wantErr, `seed ${seed}: the error`);
    assert.equal(got, want, `seed ${seed}`);
    if (want) { const L = referenceLedger({ batches, feeBps }); fills += L.batches.reduce((t, b) => t + b.fills.length, 0); sold += L.batches.reduce((t, b) => t + b.fills.filter((f) => f.sell).length, 0); rest += L.resting.sells.length; }
  }
  console.log('COVERED', JSON.stringify({ fills, sellFills: sold, restingSells: rest }));
  assert.ok(sold > 100 && rest > 100, 'the random books exercise filled and resting sells');
});

test('kanban #1791: what clearBatch refuses the indexed ledger refuses', () => {
  const id = (s) => s.padStart(64, '0');
  const base = [{ k: 0, cutoffMs: 0n, orders: [{ id: id('a'), outcome: YES, price: 60000n, stakeMsat: 200000n, feeMsat: 2000n, expiryMs: 0n }, { id: id('b'), outcome: NO, price: 45000n, stakeMsat: 200000n, feeMsat: 2000n, expiryMs: 0n }] }];
  for (const s of [{ sharesMsat: 0n }, { price: 0n }, { price: PRICE_SCALE }, { id: id('b') }]) {
    const batches = [...base, { k: 1, cutoffMs: 500n, sells: [{ id: id('5e11'), entry: id('a'), outcome: YES, price: 50000n, sharesMsat: 10n, ...s }] }];
    let a = null, b = null;
    try { referenceLedger({ batches, feeBps: 100 }); } catch (e) { a = e.message; }
    try { bookLedger({ batches, feeBps: 100 }); } catch (e) { b = e.message; }
    assert.equal(b, a, JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  assert.throws(() => bookLedger({ batches: base, feeBps: 10000 }), /a fee is 0 to 9999 bps/);
});
