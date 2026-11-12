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
import { YES, NO, PRICE_SCALE } from './order-book.js';

const byIdOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const demandAt = (o, q) => (q <= o.price ? (o.net * PRICE_SCALE) / q : 0n);   // order-book.js clearBatch's, the same

// THE LEDGER KEEPS ITS RESTING SELLS INDEXED (kanban #1722, #1791): it summed `offered` over every resting sell for each new sell and
// handed every resting sell to clearBatch in every batch - one small filled order posting 16 tiny never-filled sells at each of the 7
// seats every batch made one replay take 15 s after two minutes (26,880 resting), and every seat replays per POST /sell, lead and
// accept. Now each (entry, outcome) keeps its offered total, each entry its sells, and each side its sells by limit with their total:
// a batch costs its new sells, its buys x its prices and the sells it fills, not every resting sell. The rules are clearBatch's, to
// the msat (one clearing price, the short side whole, the long side by limit, the marginal limit pro rata, the msat left in id order;
// test/book-ledger-indexed-1791.test.js holds this ledger to the one over clearBatch on random books).
function sellChecked(o, seenIds) {
  if (typeof o.id !== 'string' || seenIds(o.id)) throw new Error('every order in a batch is named once, by its hex id');
  if (o.outcome !== YES && o.outcome !== NO) throw new Error('an order buys outcome 0 or 1');
  if (typeof o.price !== 'bigint' || o.price < 1n || o.price >= PRICE_SCALE) throw new Error('a price is inside the scale');
  if (typeof o.sharesMsat !== 'bigint' || o.sharesMsat <= 0n) throw new Error('a sell names the shares it sells, a positive BigInt');
}
function buyChecked(o, seenIds) {
  if (typeof o.id !== 'string' || seenIds(o.id)) throw new Error('every order in a batch is named once, by its hex id');
  if (o.outcome !== YES && o.outcome !== NO) throw new Error('an order buys outcome 0 or 1');
  if (typeof o.price !== 'bigint' || o.price < 1n || o.price >= PRICE_SCALE) throw new Error('a price is inside the scale');
  if (typeof o.stakeMsat !== 'bigint' || o.stakeMsat <= 0n) throw new Error('a stake is a positive BigInt msat');
}

/**
 * THE LEDGER. `batches`: the certified batches in order, each { k, cutoffMs (BigInt), orders: [{ id, outcome, price, stakeMsat,
 * feeMsat, expiryMs }], cancels: [entry id], sells: [{ id, entry, outcome, price, sharesMsat }] }; `feeBps` the market's whole
 * fee (entryFeeBpsOf). Answers { positions: Map(entry -> position), batches: [{ k, price, fills }], refused: [{ id, why }] }.
 */
export function bookLedger({ batches, feeBps }) {
  const s = new BookLedgerState({ feeBps });
  for (const b of batches) s.apply(b);
  const r = s.result();
  return { positions: r.positions, batches: r.batches, refused: r.refused, resting: r.resting, levels: r.levels };
}

/**
 * THE LEDGER, KEPT AND GROWN ONE BATCH AT A TIME (kanban #2086, after #1526/#1722/#1791/#1933/#1969). bookLedger replayed every
 * certified batch from batch 0, and a seat ran it once per batch with the next batch on top (lead(), each follower's #check) and once
 * more after each certificate: sixteen dust orders posting 16 never-crossing 1-msat sells per seat per batch rest 1,792 sells every
 * 500 ms, and three minutes in (645,120 resting) that replay took a seat 3.1 s a batch against its 500 ms interval - every seat fell
 * behind the signing lag and the book stalled for everyone. The same rules, to the msat, now run on a state kept between batches:
 *  - apply(batch): one more certified batch on top of the kept state - its cost is its own orders, cancels and sells, the buys, the
 *    sell LEVELS (one per price) and the sells it fills, never the resting history;
 *  - onTop(batch): the ledger with one more batch on top, without keeping it - every change it makes is journaled and undone after
 *    (a resting sell or buy it drops comes back; the order a book is drawn in is kept by each one's insertion number);
 *  - result(): the kept ledger; its resting ids and levels are built only when read, once per state.
 * bookLedger above is this state over the batches given, so every seat - kept, grown or replayed - holds the same ledger.
 * A position object is never changed once it is in a ledger handed out: a batch that changes one puts a new object in the map.
 */
export class BookLedgerState {
  #j = null;            // the undo journal of an onTop pass, else null
  #touched = null;      // the positions this pass already copied
  #book = null;         // the drawn book of this state, built when read
  constructor({ feeBps }) {
    this.feeBps = feeBps;
    this.positions = new Map();
    this.buys = new Map();               // entry -> its resting buy (the rest of its budget)
    this.sells = new Map();              // sell id -> its resting sell (the rest of its shares)
    // EVERY SELL ONCE (kanban #1150): a signed sell carried by a later batch too was set again at its full size - one signature, two sales
    this.seenSells = new Set();
    this.offered = new Map();            // entry|outcome -> the shares its resting sells offer
    this.sellsOf = new Map();            // entry -> the ids of its resting sells
    // each side of the clear (a sell of outcome o is a buy of 1 - o at the limit 1 - p) -> limit -> { price, total, ids }
    this.sellLevels = [new Map(), new Map()];
    this.refused = [];
    this.out = [];
    this.seq = 0;                        // insertion number of each resting buy and sell: the order a replay holds them in
    this.reordered = false;              // an undone drop put a buy or sell back at the end of its map: draw by insertion number
  }
  #set(m, k, v) { if (this.#j) { const had = m.has(k), old = m.get(k); this.#j.push(had ? () => m.set(k, old) : () => m.delete(k)); } m.set(k, v); }
  #del(m, k, ordered = false) {
    if (!m.has(k)) return;
    if (this.#j) { const old = m.get(k); this.#j.push(() => { m.set(k, old); if (ordered) this.reordered = true; }); }
    m.delete(k);
  }
  #add(s, v) { if (s.has(v)) return; if (this.#j) this.#j.push(() => s.delete(v)); s.add(v); }
  #rm(s, v) { if (!s.has(v)) return; if (this.#j) this.#j.push(() => s.add(v)); s.delete(v); }
  #total(l, d) { if (this.#j) { const old = l.total; this.#j.push(() => { l.total = old; }); } l.total += d; }
  /** a position this batch may change: a copy, put in the map once per batch */
  #mut(id) {
    const p = this.positions.get(id);
    if (this.#touched.has(id)) return p;
    const c = { ...p, shares: [...p.shares] };
    this.#touched.add(id); this.#set(this.positions, id, c);
    return c;
  }

  /** One more certified batch, kept. A batch that throws leaves this state unusable: the caller builds it again. */
  apply(b) {
    this.#touched = new Set(); this.#book = null;
    const { positions, buys, sells, seenSells, offered, sellsOf, sellLevels, refused, feeBps } = this;
    const offerKey = (x) => `${x.entry}|${x.outcome}`;
    const levelOf = (x) => sellLevels[1 - x.outcome].get(String(PRICE_SCALE - x.price));
    const addSell = (x) => {
      this.#set(sells, x.id, x);
      this.#set(offered, offerKey(x), (offered.get(offerKey(x)) || 0n) + x.sharesMsat);
      if (!sellsOf.has(x.entry)) this.#set(sellsOf, x.entry, new Set());
      this.#add(sellsOf.get(x.entry), x.id);
      const side = sellLevels[1 - x.outcome], key = String(PRICE_SCALE - x.price);
      if (!side.has(key)) this.#set(side, key, { price: PRICE_SCALE - x.price, total: 0n, ids: new Set() });
      const l = side.get(key); this.#total(l, x.sharesMsat); this.#add(l.ids, x.id);
    };
    const dropSell = (id) => {
      const x = sells.get(id);
      this.#del(sells, id, true);
      this.#set(offered, offerKey(x), offered.get(offerKey(x)) - x.sharesMsat);
      this.#rm(sellsOf.get(x.entry), id);
      const l = levelOf(x); this.#total(l, -x.sharesMsat); this.#rm(l.ids, id);
      if (!l.ids.size) this.#del(sellLevels[1 - x.outcome], String(PRICE_SCALE - x.price));
    };
    const restSell = (id, rest) => {
      const x = sells.get(id), less = x.sharesMsat - rest;
      this.#set(sells, id, { ...x, sharesMsat: rest });
      this.#set(offered, offerKey(x), offered.get(offerKey(x)) - less);
      this.#total(levelOf(x), -less);
    };
    // 1. NEW ORDERS
    for (const o of [...(b.orders || [])].sort((x, y) => byIdOrder(x.id, y.id))) {
      if (positions.has(o.id)) { refused.push({ id: o.id, why: 'that order is in the book already' }); continue; }
      const N = o.stakeMsat - o.feeMsat;
      this.#set(positions, o.id, { entry: o.id, outcome: o.outcome, N, F: o.feeMsat, cost: 0n, buyFee: 0n, shares: [0n, 0n],
        sellDebt: 0n, sellFee: 0n, cancelled: false, filledBeforeCancel: false });
      this.#touched.add(o.id);
      this.#set(buys, o.id, { id: o.id, outcome: o.outcome, price: o.price, stakeMsat: o.stakeMsat, net: N, fullNet: N, fullFee: o.feeMsat, expiryMs: o.expiryMs || 0n, seq: this.seq++ });
    }
    // 2. CANCELS: the order's rest leaves the book - its buy's and its resting sells' (kanban #591, from the Polymarket comparison:
    // a sell stood until it filled or the window closed; Polymarket cancels any open order) - what filled stays its position
    for (const e of [...(b.cancels || [])].sort(byIdOrder)) {
      if (!positions.get(e)) { refused.push({ id: e, why: 'a cancel of an order the book does not hold' }); continue; }
      this.#del(buys, e, true);
      for (const sid of [...(sellsOf.get(e) || [])]) dropSell(sid);
      if (!positions.get(e).cancelled) { const p = this.#mut(e); p.cancelled = true; p.filledBeforeCancel = p.cost > 0n || p.sellDebt > 0n; }
    }
    // 3. EXPIRY
    for (const [id, o] of [...buys]) if (o.expiryMs > 0n && o.expiryMs <= b.cutoffMs) this.#del(buys, id, true);
    // 4. SELLS: no more than its entry holds and has not already offered
    for (const s of [...(b.sells || [])].sort((x, y) => byIdOrder(x.id, y.id))) {
      const p = positions.get(s.entry);
      if (!p) { refused.push({ id: s.id, why: 'a sell of an entry the book does not hold' }); continue; }
      if (seenSells.has(s.id)) { refused.push({ id: s.id, why: 'that sell is in the book already: a signed sell is sold once' }); continue; }
      this.#add(seenSells, s.id);
      const unsold = p.shares[s.outcome] - p.shares[1 - s.outcome] - (offered.get(offerKey(s)) || 0n);
      if (s.sharesMsat > unsold) { refused.push({ id: s.id, why: `that sell offers ${s.sharesMsat} of outcome ${s.outcome} and its entry holds ${unsold > 0n ? unsold : 0n} unsold` }); continue; }
      sellChecked(s, (id) => sells.has(id));   // what clearBatch asks of a sell, asked once: a resting sell only shrinks
      addSell({ ...s, sell: true, seq: this.seq++ });
    }
    // 5. THE CLEAR (clearBatch's, over the indexed book)
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) throw new Error('a fee is 0 to 9999 bps');
    const bought = [...buys.values()].sort((x, y) => byIdOrder(x.id, y.id));
    for (const o of bought) buyChecked(o, (id) => sells.has(id));
    const buySides = [bought.filter((o) => o.outcome === YES), bought.filter((o) => o.outcome === NO)];
    const sellSides = sellLevels.map((side) => {
      const ls = [...side.values()].sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0));
      const suffix = new Array(ls.length + 1).fill(0n);
      for (let i = ls.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + ls[i].total;
      return { ls, suffix };
    });
    // the sells of side k wanting at q: every limit at or above q
    const sellDemand = (k, q) => {
      const { ls, suffix } = sellSides[k];
      let lo = 0, hi = ls.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ls[mid].price >= q) hi = mid; else lo = mid + 1; }
      return suffix[lo];
    };
    const cands = new Set();
    for (const o of bought) cands.add(String(o.outcome === YES ? o.price : PRICE_SCALE - o.price));
    for (let k = 0; k < 2; k++) for (const l of sellSides[k].ls) cands.add(String(k === YES ? l.price : PRICE_SCALE - l.price));
    const candidates = [...cands].map(BigInt).sort((a, c) => (a < c ? -1 : 1));
    let best = null;
    for (const pi of candidates) {
      const q = [pi, PRICE_SCALE - pi];
      const d = [0, 1].map((k) => buySides[k].reduce((t, o) => t + demandAt(o, q[k]), 0n) + sellDemand(k, q[k]));
      const v = d[0] < d[1] ? d[0] : d[1];
      if (v === 0n) continue;
      const gap = d[0] > d[1] ? d[0] - d[1] : d[1] - d[0];
      if (!best || v > best.v || (v === best.v && gap < best.gap)) best = { pi, v, gap, d };
    }
    const fills = new Map();   // id -> payout, only what this batch fills
    if (best) {
      const q = [best.pi, PRICE_SCALE - best.pi];
      for (let k = 0; k < 2; k++) {
        // THE SHORT SIDE FILLS WHOLE; THE LONG SIDE BY LIMIT, BETTER FIRST, THE MARGINAL LIMIT PRO RATA
        let left = best.v;
        const byLimit = new Map();
        for (const o of buySides[k]) { const w = demandAt(o, q[k]); if (w > 0n) { const key = String(o.price); if (!byLimit.has(key)) byLimit.set(key, { buys: [], level: null }); byLimit.get(key).buys.push({ id: o.id, want: w }); } }
        for (const l of sellSides[k].ls) if (q[k] <= l.price) { const key = String(l.price); if (!byLimit.has(key)) byLimit.set(key, { buys: [], level: null }); byLimit.get(key).level = l; }
        const limits = [...byLimit.keys()].map(BigInt).sort((a, c) => (a > c ? -1 : 1));
        for (const lim of limits) {
          if (left === 0n) break;
          const g = byLimit.get(String(lim));
          const total = g.buys.reduce((t, x) => t + x.want, 0n) + (g.level ? g.level.total : 0n);
          const members = () => [...g.buys, ...(g.level ? [...g.level.ids].map((id) => ({ id, want: sells.get(id).sharesMsat })) : [])];
          if (total <= left) { for (const x of members()) fills.set(x.id, x.want); left -= total; continue; }
          const group = members().sort((x, y) => byIdOrder(x.id, y.id));
          let given = 0n;
          for (const x of group) { const f = (x.want * left) / total; fills.set(x.id, f); given += f; }
          for (const x of group) { if (given === left) break; if (fills.get(x.id) < x.want) { fills.set(x.id, fills.get(x.id) + 1n); given += 1n; } }
          left = 0n;
        }
      }
    }
    const qOf = (side) => (side === YES ? (best ? best.pi : 0n) : (best ? PRICE_SCALE - best.pi : 0n));
    const rows = [];
    // every buy's row (clearBatch's), and every sell's that filled - one that did not stays as it rests
    for (const o of bought) {
      const payoutMsat = fills.get(o.id) || 0n;
      let costMsat = payoutMsat === 0n ? 0n : (payoutMsat * qOf(o.outcome) + PRICE_SCALE - 1n) / PRICE_SCALE;
      if (costMsat > o.net) costMsat = o.net;
      const feeMsat = o.fullNet === 0n ? 0n : (o.fullFee * costMsat) / o.fullNet;
      rows.push({ id: o.id, outcome: o.outcome, price: o.price, payoutMsat, costMsat, feeMsat, refundMsat: o.stakeMsat - costMsat - feeMsat, restNetMsat: o.net - costMsat });
    }
    for (const [id, payoutMsat] of fills) {
      if (buys.has(id) || payoutMsat === 0n) continue;
      const x = sells.get(id), side = 1 - x.outcome;
      const costMsat = (payoutMsat * qOf(side) + PRICE_SCALE - 1n) / PRICE_SCALE;
      const feeMsat = ((payoutMsat - costMsat) * BigInt(feeBps)) / 10000n;
      rows.push({ id, sell: true, outcome: side, sold: x.outcome, price: x.price, payoutMsat, costMsat, feeMsat, refundMsat: 0n, restSharesMsat: x.sharesMsat - payoutMsat });
    }
    rows.sort((x, y) => byIdOrder(x.id, y.id));
    // 6. THE FILLS
    // THE FEE A BUY OWES: its fee lock's share of what its fills spent, F x cost / N - the same over one batch or many, set as it changes
    for (const f of rows) {
      if (f.sell) {
        const s = sells.get(f.id);
        const p = this.#mut(s.entry);
        p.shares[f.outcome] += f.payoutMsat; p.sellDebt += f.costMsat; p.sellFee += f.feeMsat;
        if (f.restSharesMsat > 0n) restSell(f.id, f.restSharesMsat); else dropSell(f.id);
        continue;
      }
      if (f.payoutMsat > 0n) { const p = this.#mut(f.id); p.shares[f.outcome] += f.payoutMsat; p.cost += f.costMsat; p.buyFee = p.N === 0n ? 0n : (p.F * p.cost) / p.N; }
      const o = buys.get(f.id);
      if (f.restNetMsat > 0n) this.#set(buys, f.id, { ...o, net: f.restNetMsat }); else this.#del(buys, f.id, true);
    }
    this.out.push({ k: b.k, price: best ? best.pi : null, fills: rows.filter((f) => f.payoutMsat > 0n) });
  }

  /** The ledger with one more batch on top, not kept: { positions, batches, refused } (no drawn book). */
  onTop(b) {
    const j = this.#j = [];
    const nRefused = this.refused.length, nOut = this.out.length, seq = this.seq, book = this.#book;
    try {
      this.apply(b);
      return { positions: new Map(this.positions), batches: this.out.slice(), refused: this.refused.slice() };
    } finally {
      this.#j = null;
      for (let i = j.length - 1; i >= 0; i--) j[i]();
      this.refused.length = nRefused; this.out.length = nOut; this.seq = seq; this.#book = book;
    }
  }

  /** The kept ledger: { positions (the live map: read it, never change it), batches, refused, resting, levels (built when read, from
   *  the state as it is then - read them before the next apply) }. */
  result() {
    const self = this;
    return { positions: this.positions, batches: this.out.slice(), refused: this.refused.slice(),
      get resting() { return self.#drawn().resting; }, get levels() { return self.#drawn().levels; } };
  }
  // WHAT STANDS, PRICED (2026-10-17: "a real desktop view with complete order book bids ask, chart, depth"): each
  // resting buy's outcome, limit and the rest of its budget, each resting sell's outcome, price and unsold shares - the book a page
  // draws, no id and no entry named
  #drawn() {
    if (this.#book) return this.#book;
    const buys = [...this.buys.values()], sells = [...this.sells.values()];
    if (this.reordered) { buys.sort((a, b) => a.seq - b.seq); sells.sort((a, b) => a.seq - b.seq); }
    this.#book = { resting: { buys: buys.map((o) => o.id), sells: sells.map((x) => x.id) },
      levels: { buys: buys.map((o) => ({ outcome: o.outcome, price: o.price, netMsat: o.net, expiryMs: o.expiryMs || 0n })),
        sells: sells.map((x) => ({ outcome: x.outcome, price: x.price, sharesMsat: x.sharesMsat })) } };
    return this.#book;
  }
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
