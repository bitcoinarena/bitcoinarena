// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MARKET ORDER BOOK: SIGNED LIMIT ORDERS, CLEARED IN BATCHES AT ONE UNIFORM PRICE (design (c), the owner
// 2026-10-09: "batch auction"). A two-outcome market (YES = outcome 0, NO = outcome 1) with no house: every share is half of
// a COMPLETE SET - 1 sat of collateral pays 1 sat to whichever side wins - so a YES buyer at price p and a NO buyer at
// 1 - p together fund a set, and nobody else does.
//
//   ORDER. A player's limit order: buy outcome o for at most `stakeMsat` (its whole commitment, fees included) at a price
//          no worse than `price` - a fraction of 1 sat per 1 sat of payout, on PRICE_SCALE, in whole cents (TICK, as on
//          Polymarket: 0.74 is 74000). Signed by the player's key over `orderId`.
//   BATCH. The seats agree only on WHICH orders are in a batch (a set, signed as receipts are); `clearBatch` is a pure
//          function of that set, so every seat clears it the same way - no arrival order, nothing to front-run.
//   CLEAR. One price for the batch: the price of YES that matches the most payout (YES demand against NO demand), then the
//          smaller imbalance, then the lower price. The short side fills whole; on the long side the better limits fill
//          first and the marginal limit is shared pro rata, its leftover msat one each in order-id order.
//   FEES ARE DUE WHEN AN ORDER FILLS (2026-10-09: "when an order is filled, the fee is of course due too"; 1 sat on a
//          price to beat of 73999: 0.01 sat fee, 0.99 sat x odds): an order's fee is its market's rate (1 % by default) of
//          the part that filled - held in its fee lock and paid out at settlement; what has not filled can be cancelled at
//          no cost and comes back whole, its fee too. A VOID market gives everything back.
import { Writer } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';

export const PRICE_SCALE = 100000n;
// UP AND DOWN (the Polymarket market this follows, up-down.js): outcome 0 is Up (YES), 1 is Down (NO)
export const YES = 0;
export const NO = 1;
// POLYMARKET'S BOOK (btc-updown-15m: orderPriceMinTickSize 0.01, orderMinSize 5): a price is a whole cent of a share, and an
// order buys at least 5 shares at its limit - one share pays 1 sat here, as one pays $1 there
export const TICK = 1000n;
export const MIN_SHARES = 5n;
// AN ORDER BRINGS ITS OWN AMOUNT (2026-10-10: market and limit orders, "Für market Orders"): in a paid
// market round an order's stake is the player's - from 1 sat up to this cap - and the round's stake_msat is only what a
// plain pick stakes. Its shares follow (MIN_SHARES at its limit, as Polymarket's minimum).
export const MIN_ORDER_MSAT = 1000n;
export const MAX_ORDER_MSAT = 100000000n;   // 100,000 sat
export const SHARE_MSAT = 1000n;

const obIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * The order's id, the bytes its player signs: round, player key, outcome, price, stake, nonce, and its expiry -
 * `expiryMs` 0 stands until it fills or is cancelled (Polymarket's GTC), a time stands until then (GTD).
 */
export function orderId({ roundId, playerKey, outcome, price, stakeMsat, nonce, expiryMs = 0n }) {
  const why = orderShapeWhy({ roundId, playerKey, outcome, price, stakeMsat, nonce, expiryMs });
  if (why) throw new Error(why);
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(playerKey); w.u8(outcome); w.u32(Number(price)); w.u64(stakeMsat); w.u64(nonce); w.u64(expiryMs);
  return taggedHash(TAG.marketOrder, w.finish());
}

function orderShapeWhy({ roundId, playerKey, outcome, price, stakeMsat, nonce, expiryMs = 0n }) {
  if (!obIs32(roundId)) return 'an order names its 32-byte round';
  if (!obIs32(playerKey)) return 'an order names its 32-byte player key';
  if (outcome !== YES && outcome !== NO) return 'an order buys outcome 0 (YES) or 1 (NO)';
  if (typeof price !== 'bigint' || price < 1n || price >= PRICE_SCALE) return `a price is 1 to ${PRICE_SCALE - 1n} of ${PRICE_SCALE}`;
  if (typeof stakeMsat !== 'bigint' || stakeMsat <= 0n) return 'an order stakes a positive BigInt msat amount';
  if (typeof nonce !== 'bigint' || nonce < 0n) return 'an order names a BigInt nonce';
  if (typeof expiryMs !== 'bigint' || expiryMs < 0n) return 'an order\'s expiry is BigInt ms, 0 for none';
  return null;
}

/**
 * A CANCEL (2026-10-09: "until then the orders can be cancelled at no cost"): the bytes a player signs, with the
 * entry's own session key, to take a market entry back before its round's entry close - round and entry, nothing else.
 * Only what has not filled comes back free: a filled order's fee is due (2026-10-09: "when an order is filled, the
 * fee is of course due too").
 */
export function cancelId({ roundId, entryId }) {
  if (!obIs32(roundId) || !obIs32(entryId)) throw new Error('a cancel names a 32-byte round and a 32-byte entry');
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(entryId);
  return taggedHash(TAG.marketCancel, w.finish());
}

/**
 * Does this order stand: its shape, a whole tick, at least the minimum shares at its limit (after its fee), and its player's
 * signature over its id (`verify(signature, id, key)`, injected). `feeBps`: the market's whole fee (entryFeeBpsOf).
 */
export function orderStands(order, { verify, roundId = null, feeBps = 100, tick = TICK, minShares = MIN_SHARES } = {}) {
  const why = orderShapeWhy(order);
  if (why) return { ok: false, why };
  if (order.price % tick !== 0n) return { ok: false, why: `a price is a whole tick of ${tick} (${Number(tick) / Number(PRICE_SCALE)}): ${order.price} is not` };
  const shares = (orderNetMsat(order.stakeMsat, feeBps) * PRICE_SCALE) / order.price / SHARE_MSAT;
  if (shares < minShares) return { ok: false, why: `an order buys at least ${minShares} shares at its limit, and that one buys ${shares}` };
  if (roundId && toHex(roundId) !== toHex(order.roundId)) return { ok: false, why: 'that order is for another round' };
  if (typeof verify !== 'function') return { ok: false, why: 'no verifier to check the order\'s signature' };
  const id = orderId(order);
  let good = false;
  try { good = verify(order.signature, id, order.playerKey) === true; } catch { good = false; }
  return good ? { ok: true, id } : { ok: false, why: 'that order\'s signature is not its player\'s' };
}

/** What an order can spend on shares: its stake less its fee (the fee itself is held, due at resolution). */
export const orderNetMsat = (stakeMsat, feeBps) => stakeMsat - (stakeMsat * BigInt(feeBps)) / 10000n;

// the payout an order buys at side price q: floor(net * SCALE / q) - 0 above its limit
const demandAt = (o, q) => (q <= o.price ? (o.net * PRICE_SCALE) / q : 0n);

/**
 * CLEAR ONE BATCH. `orders`: [{ id (hex), outcome, price (BigInt), stakeMsat (BigInt) }] - the batch's set, in any order;
 * `feeBps`: the market's whole fee (entryFeeBpsOf: node fee + donation). Answers { price (of YES, or null if nothing
 * crossed), matchedMsat (the payout matched each side), fills: [{ id, outcome, payoutMsat, costMsat, feeMsat, refundMsat }] }
 * - one row per order, in id order; an unmatched order fills 0 and its whole stake is its refund.
 *
 * AN ORDER BACKED BY LOCKS (comment 1127) carries `fullNet` and `fullFee` - its stake lock and its fee lock -
 * and `net`, what is left of its budget: its fee is then `fullFee x cost / fullNet`, the share of its fee lock its fill
 * used, the same over one batch or many. A SELL (`sell: true`, `outcome` the outcome sold, `price` the least it takes a
 * share, `sharesMsat` the payout units sold): selling s of an outcome at >= p is buying s of the other at <= 1 - p, paid
 * for by the shares already held - an Up and a Down share make one complete set, which pays 1 sat whatever happens. So it
 * is one more order of the other side, its demand fixed at s; its cost (`costMsat`) is owed out of that set at settlement,
 * what is left of the set is its proceeds, and its fee is the market's rate of the proceeds.
 */
export function clearBatch({ orders, feeBps }) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) throw new Error('a fee is 0 to 9999 bps');
  const seen = new Set();
  const book = [];
  for (const o of orders) {
    if (typeof o.id !== 'string' || seen.has(o.id)) throw new Error('every order in a batch is named once, by its hex id');
    seen.add(o.id);
    if (o.outcome !== YES && o.outcome !== NO) throw new Error('an order buys outcome 0 or 1');
    if (typeof o.price !== 'bigint' || o.price < 1n || o.price >= PRICE_SCALE) throw new Error('a price is inside the scale');
    if (o.sell) {
      if (typeof o.sharesMsat !== 'bigint' || o.sharesMsat <= 0n) throw new Error('a sell names the shares it sells, a positive BigInt');
      // THE SELL AS A BUY OF THE OTHER SIDE: its limit 1 - p, its demand the shares it sells
      book.push({ ...o, sold: o.outcome, outcome: 1 - o.outcome, price: PRICE_SCALE - o.price, fixed: o.sharesMsat });
      continue;
    }
    if (typeof o.stakeMsat !== 'bigint' || o.stakeMsat <= 0n) throw new Error('a stake is a positive BigInt msat');
    book.push({ ...o, net: typeof o.net === 'bigint' ? o.net : orderNetMsat(o.stakeMsat, feeBps) });
  }
  book.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sides = [book.filter((o) => o.outcome === YES), book.filter((o) => o.outcome === NO)];
  const want = (o, q) => (o.fixed !== undefined ? (q <= o.price ? o.fixed : 0n) : demandAt(o, q));

  // THE CANDIDATE PRICES: every limit, as the price of YES it means
  const candidates = [...new Set(book.map((o) => String(o.outcome === YES ? o.price : PRICE_SCALE - o.price)))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
  let best = null;
  for (const pi of candidates) {
    const q = [pi, PRICE_SCALE - pi];
    const d = sides.map((s, k) => s.reduce((t, o) => t + want(o, q[k]), 0n));
    const v = d[0] < d[1] ? d[0] : d[1];
    if (v === 0n) continue;
    const gap = d[0] > d[1] ? d[0] - d[1] : d[1] - d[0];
    if (!best || v > best.v || (v === best.v && gap < best.gap)) best = { pi, v, gap, d };
  }
  const fills = new Map(book.map((o) => [o.id, 0n]));
  if (best) {
    const q = [best.pi, PRICE_SCALE - best.pi];
    for (let k = 0; k < 2; k++) {
      // THE SHORT SIDE FILLS WHOLE; THE LONG SIDE BY LIMIT, BETTER FIRST, THE MARGINAL LIMIT PRO RATA
      let left = best.v;
      const byLimit = new Map();
      for (const o of sides[k]) { const w = want(o, q[k]); if (w > 0n) { const key = String(o.price); if (!byLimit.has(key)) byLimit.set(key, []); byLimit.get(key).push({ o, want: w }); } }
      const limits = [...byLimit.keys()].map(BigInt).sort((a, b) => (a > b ? -1 : 1));
      for (const lim of limits) {
        if (left === 0n) break;
        const group = byLimit.get(String(lim));
        const total = group.reduce((t, x) => t + x.want, 0n);
        if (total <= left) { for (const x of group) fills.set(x.o.id, x.want); left -= total; continue; }
        let given = 0n;
        for (const x of group) { const f = (x.want * left) / total; fills.set(x.o.id, f); given += f; }
        for (const x of group) { if (given === left) break; if (fills.get(x.o.id) < x.want) { fills.set(x.o.id, fills.get(x.o.id) + 1n); given += 1n; } }
        left = 0n;
      }
    }
  }
  const rows = book.map((o) => {
    const payoutMsat = fills.get(o.id);
    const q = o.outcome === YES ? (best ? best.pi : 0n) : (best ? PRICE_SCALE - best.pi : 0n);
    // WHAT THE FILL COSTS, rounded up so the sets are always funded - never above the order's net (its limit bounds it)
    let costMsat = payoutMsat === 0n ? 0n : (payoutMsat * q + PRICE_SCALE - 1n) / PRICE_SCALE;
    if (o.fixed !== undefined) {
      // A SELL: the cost is owed out of the complete set it closes; its fee is the market's rate of the proceeds
      const proceeds = payoutMsat - costMsat;
      const feeMsat = (proceeds * BigInt(feeBps)) / 10000n;
      return { id: o.id, sell: true, outcome: o.outcome, sold: o.sold, price: PRICE_SCALE - o.price, payoutMsat, costMsat, feeMsat, refundMsat: 0n,
        restSharesMsat: o.fixed - payoutMsat };
    }
    if (costMsat > o.net) costMsat = o.net;
    const feeMsat = typeof o.fullNet === 'bigint'
      ? (o.fullNet === 0n ? 0n : (o.fullFee * costMsat) / o.fullNet)
      : (o.net === 0n ? 0n : ((o.stakeMsat - o.net) * costMsat) / o.net);
    return { id: o.id, outcome: o.outcome, price: o.price, payoutMsat, costMsat, feeMsat, refundMsat: o.stakeMsat - costMsat - feeMsat, restNetMsat: o.net - costMsat };
  });
  return { price: best ? best.pi : null, matchedMsat: best ? best.v : 0n, fills: rows };
}

/**
 * THE MARKET RESOLVED: what each filled order is paid and what fee falls due. `fills`: the cleared rows of every batch;
 * `outcome`: YES or NO, or null for a VOID market (everything back: every cost and every fee). The winning side shares the
 * whole collateral - every fill's cost - pro rata by its payout, the msat left one each in id order; every fill's fee is
 * due, winners' and losers' alike. Answers { rows: [{ id, paidMsat, feeMsat }], poolMsat, feesMsat }.
 */
export function resolveBook({ fills, outcome }) {
  // AN ORDER THAT FILLED IN SEVERAL BATCHES IS ONE POSITION: its fills summed
  const byId = new Map();
  for (const f of fills) {
    const t = byId.get(f.id);
    if (!t) { byId.set(f.id, { id: f.id, outcome: f.outcome, payoutMsat: f.payoutMsat, costMsat: f.costMsat, feeMsat: f.feeMsat }); continue; }
    if (t.outcome !== f.outcome) throw new Error('one order buys one outcome');
    t.payoutMsat += f.payoutMsat; t.costMsat += f.costMsat; t.feeMsat += f.feeMsat;
  }
  const rows = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const poolMsat = rows.reduce((t, r) => t + r.costMsat, 0n);
  if (outcome === null) return { rows: rows.map((r) => ({ id: r.id, paidMsat: r.costMsat + r.feeMsat, feeMsat: 0n })), poolMsat, feesMsat: 0n, voided: true };
  if (outcome !== YES && outcome !== NO) throw new Error('a market resolves to 0 (YES), 1 (NO) or null (VOID)');
  const winners = rows.filter((r) => r.outcome === outcome && r.payoutMsat > 0n);
  const claim = winners.reduce((t, r) => t + r.payoutMsat, 0n);
  const paid = new Map();
  let given = 0n;
  for (const r of winners) { const p = (r.payoutMsat * poolMsat) / claim; paid.set(r.id, p); given += p; }
  for (const r of winners) { if (given === poolMsat) break; paid.set(r.id, paid.get(r.id) + 1n); given += 1n; }
  const out = rows.map((r) => ({ id: r.id, paidMsat: paid.get(r.id) || 0n, feeMsat: r.feeMsat }));
  return { rows: out, poolMsat, feesMsat: rows.reduce((t, r) => t + r.feeMsat, 0n), voided: false };
}

/**
 * STANDING ORDERS (2026-10-09: "Gut weiter" - batches every half second (measured: the seats agree a set in at most 275 ms), orders that stand): a player places a limit order at
 * any time and it is matched in the next batch; what has not filled STANDS in the book for the batches after, until it
 * fills, its player cancels it (at no cost) or its expiry passes. One batch of the book: `resting` - the orders standing,
 * each with what is left of its stake; `incoming` - the orders placed since the last batch; `cancels` - ids its players
 * cancelled; `nowMs` - the batch's time (an order whose expiry is at or before it is out). Answers { price, fills (this
 * batch's, filled only), resting (left standing, each with its remaining stake), returned: [{ id, stakeMsat, why }] (what
 * comes back now: cancelled or expired, untouched by this batch) }.
 */
// EVERY HALF SECOND (2026-10-09: "Order batches alle 1s, wenn möglich alle 0.5s"measured): seven
// seats agreed every batch's set in at most 275 ms (p50 225 ms) with every seat-to-seat request delayed by a round trip
// measured to a live seat through its tunnel (p50 56 ms, max 106 ms) - inside 0.5 s, so the book runs at 0.5 s, not 1 s.
export const BATCH_MS = 500n;
export const MIN_BATCH_MS = 500n;
export function bookBatch({ resting = [], incoming = [], cancels = [], nowMs, feeBps }) {
  if (typeof nowMs !== 'bigint') throw new Error('a batch is cleared at a BigInt ms time');
  const cancelled = new Set(cancels);
  const returned = [];
  const live = [];
  const seen = new Set();
  for (const o of [...resting, ...incoming]) {
    if (seen.has(o.id)) continue;                         // placed twice: once is one order
    seen.add(o.id);
    if (cancelled.has(o.id)) { returned.push({ id: o.id, stakeMsat: o.stakeMsat, why: 'cancelled' }); continue; }
    if (o.expiryMs && o.expiryMs > 0n && o.expiryMs <= nowMs) { returned.push({ id: o.id, stakeMsat: o.stakeMsat, why: 'expired' }); continue; }
    live.push(o);
  }
  const b = clearBatch({ orders: live, feeBps });
  const byId = new Map(live.map((o) => [o.id, o]));
  const fills = b.fills.filter((f) => f.payoutMsat > 0n);
  // WHAT IS LEFT STANDS: an order's refund is its remaining stake (its fee on that part not charged), into the next batch
  const resting2 = b.fills.filter((f) => f.refundMsat > 0n).map((f) => ({ ...byId.get(f.id), stakeMsat: f.refundMsat }));
  return { price: b.price, matchedMsat: b.matchedMsat, fills, resting: resting2, returned };
}

/**
 * AN ORDER ON THE WIRE: JSON with hex bytes and decimal amounts, as a page posts it to every seat
 * (POST /order) and a seat hands it to another. `orderFromJson` answers the order or throws; the signature is checked by
 * `orderStands`, never here.
 */
export function orderToJson(o) {
  return { roundId: toHex(o.roundId), playerKey: toHex(o.playerKey), outcome: o.outcome, price: String(o.price), stakeMsat: String(o.stakeMsat),
    nonce: String(o.nonce), expiryMs: String(o.expiryMs || 0n), signature: toHex(o.signature) };
}
export function orderFromJson(j) {
  const hex = (s, n) => { if (typeof s !== 'string' || s.length !== 2 * n || !/^[0-9a-f]+$/i.test(s)) throw new Error(`an order's bytes are ${n} hex bytes`); return Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))); };
  const int = (s) => { if (typeof s !== 'string' || !/^[0-9]{1,20}$/.test(s)) throw new Error('an order\'s amounts are decimal strings'); return BigInt(s); };
  if (!j || typeof j !== 'object') throw new Error('an order is a JSON object');
  return { roundId: hex(j.roundId, 32), playerKey: hex(j.playerKey, 32), outcome: j.outcome, price: int(j.price), stakeMsat: int(j.stakeMsat),
    nonce: int(j.nonce), expiryMs: int(j.expiryMs ?? '0'), signature: hex(j.signature, 64) };
}

/**
 * ONE BATCH'S ID, the bytes every seat signs when it holds that batch: the round, the batch's number
 * (batch k takes what reached any seat before (k + 1) x the interval) and its order ids in order. Two seats that signed the
 * same id hold the same set, so they clear it the same way (`bookBatch` is a pure function of it).
 */
export function bookBatchId({ roundId, k, orderIds }) {
  if (!obIs32(roundId)) throw new Error('a batch names its 32-byte round');
  if (typeof k !== 'bigint' || k < 0n) throw new Error('a batch number is a BigInt');
  const ids = [...orderIds].sort();
  if (new Set(ids).size !== ids.length) throw new Error('an order is in a batch once');
  const w = new Writer();
  w.bytes32(roundId); w.u64(k); w.u32(ids.length);
  for (const id of ids) w.bytes32(Uint8Array.from(id.match(/../g).map((x) => parseInt(x, 16))));
  return taggedHash(TAG.marketBatch, w.finish());
}

/**
 * A SELL (comment 1127): the bytes a player signs, with its market entry's session key, to sell `sharesMsat`
 * of `outcome` that entry holds, for at least `price` a share - matched in a batch, its proceeds paid at settlement (a).
 */
export function sellId({ roundId, entryId, outcome, price, sharesMsat, nonce }) {
  if (!obIs32(roundId) || !obIs32(entryId)) throw new Error('a sell names a 32-byte round and its 32-byte entry');
  if (outcome !== YES && outcome !== NO) throw new Error('a sell sells outcome 0 or 1');
  if (typeof price !== 'bigint' || price < 1n || price >= PRICE_SCALE) throw new Error('a sell price is inside the scale');
  if (typeof sharesMsat !== 'bigint' || sharesMsat <= 0n || typeof nonce !== 'bigint' || nonce < 0n) throw new Error('a sell names its shares and a nonce, BigInt');
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(entryId); w.u8(outcome); w.u32(Number(price)); w.u64(sharesMsat); w.u64(nonce);
  return taggedHash(TAG.marketSell, w.finish());
}

/** A seat's decline of batch k: it did not sign it and never will - enough of them and the batch can never be certified. */
export function batchDeclineId({ roundId, k }) {
  if (!obIs32(roundId) || typeof k !== 'bigint') throw new Error('a decline names a 32-byte round and a BigInt batch');
  const w = new Writer();
  w.bytes32(roundId); w.u64(k);
  return taggedHash(TAG.marketBatchDecline, w.finish());
}
