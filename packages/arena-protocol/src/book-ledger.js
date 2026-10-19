// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORDER BOOK'S LEDGER AND ITS SETTLEMENT (comment 1127; 2026-10-09: "(a)"). A pure function of the
// certified batches, so every seat that holds the same batches holds the same positions and builds the same settlement.
//
// An order is an entry: its STAKE LOCK holds its budget less its fee (N), its FEE LOCK the fee (F). A lock moves whole, so
// nothing moves while the market trades: a fill, a cancel and a sell change this ledger only. At resolution every lock with
// a fill is claimed - whole - and paid out of in one settlement; a lock with no fill comes back whole by the return door.
//
//   a batch, in order:  1. its new orders join the book   2. its cancels take their orders' rest out (nothing more fills)
//                       3. orders past their expiry leave  4. its sells join, each no more than its entry holds unsold
//                       5. the book clears (clearBatch)    6. every fill lands in its entry's position
//   a position:         shares of each outcome (payout msat), the cost its buys paid out of N, the fee its buys owe out of F
//                       (F x cost / N), what its sells owe out of the sets they closed, and their fees
//   resolution:         every winning share is paid out of the pool of all collateral (pro rata, the msat left in id
//                       order); each claimed entry gets its winnings, less its sells' debt and fee, plus the rest of N and
//                       of F it did not spend (the owner: "(a)" - a cancelled or partly filled order's rest comes back here,
//                       as a seller's proceeds do); the fees due go to the nodes and the donation.
import { clearBatch, YES, NO } from './order-book.js';

const byIdOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * THE LEDGER. `batches`: the certified batches in order, each { k, cutoffMs (BigInt), orders: [{ id, outcome, price, stakeMsat,
 * feeMsat, expiryMs }], cancels: [entry id], sells: [{ id, entry, outcome, price, sharesMsat }] }; `feeBps` the market's whole
 * fee (entryFeeBpsOf). Answers { positions: Map(entry -> position), batches: [{ k, price, fills }], refused: [{ id, why }] }.
 */
export function bookLedger({ batches, feeBps }) {
  const positions = new Map();
  const buys = new Map();               // entry -> its resting buy (the rest of its budget)
  const sells = new Map();              // sell id -> its resting sell (the rest of its shares)
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
    // 2. CANCELS: the order's rest leaves the book; what filled stays its position
    for (const e of [...(b.cancels || [])].sort(byIdOrder)) {
      const p = positions.get(e);
      if (!p) { refused.push({ id: e, why: 'a cancel of an order the book does not hold' }); continue; }
      buys.delete(e);
      if (!p.cancelled) { p.cancelled = true; p.filledBeforeCancel = p.cost > 0n || p.sellDebt > 0n; }
    }
    // 3. EXPIRY
    for (const [id, o] of buys) if (o.expiryMs > 0n && o.expiryMs <= b.cutoffMs) buys.delete(id);
    // 4. SELLS: no more than its entry holds and has not already offered
    for (const s of [...(b.sells || [])].sort((x, y) => byIdOrder(x.id, y.id))) {
      const p = positions.get(s.entry);
      if (!p) { refused.push({ id: s.id, why: 'a sell of an entry the book does not hold' }); continue; }
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

/** Whether an entry's locks can come back now: no fill at all, and a certified cancel (or, at settlement, simply no fill). */
export const positionFilled = (p) => !!p && (p.cost > 0n || p.sellDebt > 0n || p.shares[0] > 0n || p.shares[1] > 0n);

/**
 * THE SETTLEMENT TABLE. `positions` from bookLedger; `outcome` YES / NO, or null for a VOID market (nothing claimed, every
 * lock back). Answers { claimed: [{ entry, stakeMsat (N), feeMsat (F), outMsat, winMsat, buyFeeMsat, sellFeeMsat }],
 * poolMsat, feesDueMsat } - every entry with a fill, its locks claimed whole; the sum of every out and the fees due is the
 * sum of the locks claimed, to the msat.
 */
//
// A SCALAR MARKET'S BOOK (§0A.7e "Left: an order book for scalar sides"): `scalar` { value, bounds { low, high } } in
// place of an outcome. A LONG share (0) is worth (V - low) / (high - low) of a sat at the clamped value V and a SHORT share (1) the
// rest, so the pool is split between the two sides by where V lies - LONG's part floored, SHORT the remainder - and each side's
// part pro rata by its shares, the msat left one each in entry order; a side holding no share hands its part to the other.
export function bookSettlement({ positions, outcome, scalar = null }) {
  if (outcome === null && !scalar) return { claimed: [], poolMsat: 0n, feesDueMsat: 0n, voided: true };
  if (!scalar && outcome !== YES && outcome !== NO) throw new Error('a market resolves to 0 (YES), 1 (NO) or null (VOID)');
  const rows = [...positions.values()].filter(positionFilled).sort((a, b) => byIdOrder(a.entry, b.entry));
  const pool = rows.reduce((t, p) => t + p.cost + p.sellDebt, 0n);
  const win = new Map(rows.map((p) => [p.entry, 0n]));
  // one side's part of the pool, pro rata by its shares, the msat left one each in entry order
  const pay = (side, part) => {
    const claim = rows.reduce((t, p) => t + p.shares[side], 0n);
    if (claim === 0n || part === 0n) return part;
    let given = 0n;
    for (const p of rows) { const w = (p.shares[side] * part) / claim; win.set(p.entry, win.get(p.entry) + w); given += w; }
    for (const p of rows) { if (given >= part) break; if (p.shares[side] > 0n) { win.set(p.entry, win.get(p.entry) + 1n); given += 1n; } }
    return 0n;
  };
  if (scalar) {
    const { low, high } = scalar.bounds || {};
    if (typeof scalar.value !== 'bigint' || typeof low !== 'bigint' || typeof high !== 'bigint' || low >= high)
      throw new Error('a scalar book settles on a BigInt value between bounds low < high');
    const v = scalar.value < low ? low : scalar.value > high ? high : scalar.value;
    const longPart = (pool * (v - low)) / (high - low);
    const leftLong = pay(YES, longPart);
    const leftShort = pay(NO, pool - longPart + leftLong);
    if (leftShort > 0n && pay(YES, leftShort) > 0n) throw new Error('a filled scalar book holds no share on either side');
  } else {
    const claim = rows.reduce((t, p) => t + p.shares[outcome], 0n);
    if (claim > 0n) pay(outcome, pool);
  }
  const claimed = rows.map((p) => {
    const winMsat = win.get(p.entry);
    const outMsat = winMsat - p.sellDebt - p.sellFee + (p.N - p.cost) + (p.F - p.buyFee);
    if (outMsat < 0n) throw new Error(`entry ${p.entry.slice(0, 16)} would be owed less than nothing`);
    return { entry: p.entry, stakeMsat: p.N, feeMsat: p.F, outMsat, winMsat, buyFeeMsat: p.buyFee, sellFeeMsat: p.sellFee };
  });
  const feesDueMsat = claimed.reduce((t, r) => t + r.buyFeeMsat + r.sellFeeMsat, 0n);
  const locks = claimed.reduce((t, r) => t + r.stakeMsat + r.feeMsat, 0n);
  const paid = claimed.reduce((t, r) => t + r.outMsat, 0n);
  if (paid + feesDueMsat !== locks) throw new Error(`the book does not balance: ${paid} paid and ${feesDueMsat} in fees of ${locks} claimed`);
  return { claimed, poolMsat: pool, feesDueMsat, voided: false };
}
