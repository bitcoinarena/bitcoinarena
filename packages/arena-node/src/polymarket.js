// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A POLYMARKET-COMPATIBLE READ OF THIS SEAT'S MARKETS (kanban #736, a tester in Arena Chat 2026-10-27: "1:1 polymarket
// api for prediction markets so bots can just use another end point"). Mounted at /polymarket/ - the base URL a bot points at in
// place of https://clob.polymarket.com - it answers Polymarket's CLOB paths with Polymarket's parameters and JSON shapes, from what
// this seat holds: its hosted two-outcome markets (an Up/Down window round is one market), their order books (order-batch.js
// cleared levels), prices, the certified batches as trades and price history.
//
//   THE MAPPING.  a market round            -> a market: condition_id = "0x" + the round id (Polymarket's condition ids are 0x + 32 bytes)
//                 its two outcomes          -> two tokens: token_id = the round id as a uint256 with its lowest bit set to the outcome
//                                             (0 Up/YES, 1 Down/NO) - a decimal string, as Polymarket's; a seat reads the round back
//                                             from the token (tokenRound) with no table, so no token is ever unknown
//                 a price on PRICE_SCALE    -> a decimal in [0, 1] ("0.55" for 55000); the tick is a cent, as there
//                 a share (1 sat of payout)  -> one share (1 $ there); sizes are shares as decimal strings
//                 an order (an entry)        -> an order: id "0x" + the entry id, side BUY (every Arena entry buys), its sell a SELL
//                 a certified batch's fills  -> trades at the batch's clearing price, transaction hash = the batch id
//
//   WHAT A SEAT CANNOT DO is place an order. Polymarket's POST /order carries a signed EIP-712 order and the exchange moves the funds;
//   here the player's keys and e-cash notes live with the player (market.js in the page, tools/market-bot.mjs for a script), and an
//   order is a stake lock and a fee lock in the federation plus a handout to the seated signer nodes - nothing a seat may do in a
//   player's name. So the seat's POST /order, DELETE /order and the L2 doors (/auth, /data/orders by owner) answer 501 by name, and the
//   writing half of the API is the ARENA CLOB ADAPTER beside the bot (tools/polymarket-adapter.mjs): the same paths on localhost,
//   reads passed through to a seat, writes done with the bot's own wallet as market-bot.mjs does them. The reads here are public, so
//   a stock client needs no key for them.
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { PRICE_SCALE, TICK, MIN_SHARES, SHARE_MSAT, YES, NO } from '../../arena-protocol/src/order-book.js';
import { positionFilled } from '../../arena-protocol/src/book-ledger.js';
import { marketOfRound } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

export const BASE = '/polymarket';
/** Polymarket's cursors: the first page is "MA==" (base64 "0"), the end "LTE=" (base64 "-1"). */
export const FIRST_CURSOR = 'MA==';
export const END_CURSOR = 'LTE=';
const TICK_SIZE = '0.01';
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const iso = (ms) => new Date(Number(ms)).toISOString();

// ---- IDS ----
/** condition_id of a round: "0x" + its 64 hex. */
export const conditionIdOf = (roundHex) => `0x${roundHex}`;
/** The round of a condition id (with or without 0x), or null. */
export function roundOfCondition(s) {
  const h = String(s || '').toLowerCase().replace(/^0x/, '');
  return isHex64(h) ? h : null;
}
/** token_id of (round, outcome): the round id as a uint256 whose lowest bit is the outcome - a decimal string. */
export function tokenIdOf(roundHex, outcome) {
  if (!isHex64(roundHex) || (outcome !== YES && outcome !== NO)) throw new Error('a token is a round (64 hex) and an outcome 0 or 1');
  return (((BigInt(`0x${roundHex}`) >> 1n) << 1n) | BigInt(outcome)).toString(10);
}
/** The outcome a token names and the two round ids it may belong to (the one held decides). null for a string that is no token. */
export function tokenRound(tokenId) {
  if (!/^[0-9]{1,78}$/.test(String(tokenId || ''))) return null;
  const t = BigInt(tokenId);
  if (t >= 1n << 256n) return null;
  const base = (t >> 1n) << 1n;
  const hex = (x) => x.toString(16).padStart(64, '0');
  return { outcome: Number(t & 1n), candidates: [hex(base), hex(base | 1n)] };
}
/** order id of an entry: "0x" + its 64 hex; and back. */
export const orderIdOf = (entryHex) => `0x${entryHex}`;
export const entryOfOrderId = (s) => roundOfCondition(s);

// ---- NUMBERS ----
/** A PRICE_SCALE price as Polymarket's decimal string: whole cents as "0.55", anything finer with the digits it needs. */
export function priceDecimal(price) {
  const p = BigInt(price);
  if (p < 0n || p > PRICE_SCALE) throw new Error(`a price is 0 to ${PRICE_SCALE}`);
  if (p === PRICE_SCALE) return '1';
  if (p === 0n) return '0';
  return `0.${p.toString(10).padStart(5, '0').replace(/0+$/, '')}`;
}
/** A decimal price ("0.55", 0.55) on PRICE_SCALE, rounded to the tick (a cent), or null outside (0, 1). */
export function priceFromDecimal(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  const cents = Math.round(n * 100);
  if (cents < 1 || cents > 99) return null;
  return BigInt(cents) * TICK;
}
/** Shares (1 sat of payout each) from msat, as a decimal string with at most 3 places. */
export function sharesDecimal(msat) {
  const m = BigInt(msat);
  const whole = m / SHARE_MSAT, rest = m % SHARE_MSAT;
  return rest === 0n ? whole.toString(10) : `${whole}.${rest.toString(10).padStart(3, '0').replace(/0+$/, '')}`;
}
/** The shares a resting buy of `netMsat` at `price` would take: net / price. */
export const buyShares = (netMsat, price) => (BigInt(netMsat) * PRICE_SCALE) / BigInt(price);   // in msat of payout

// ---- THE MARKET ----
/** The question of a market round: the window's for a period market ("BTC up at <window end>?"), else its own or its manifest's. */
export function questionOf(manifest, contract, window) {
  const m = marketOfRound(manifest, contract);
  if (contract.event && contract.event.question) return contract.event.question;
  if (window && /updown|up-down/i.test(String(manifest.gameName))) return `BTC up at ${iso(window.endMs)}?`;
  if (m.marketTerms && m.marketTerms.question) return m.marketTerms.question;
  return `${manifest.gameName}: ${m.outcomes.join(' or ')}?`;
}
const slugOf = (manifest, window, roundHex) => (window ? `${manifest.gameName}-${Number(window.startMs / 1000n)}` : `${manifest.gameName}-${roundHex.slice(0, 16)}`);

/**
 * THE CLOB MARKET (GET /markets, /markets/{condition_id}). `levels` from the ledger (bookLedger), `outcome` the seat's GET /outcome
 * answer (null before any), `last` the last batch price (YES, PRICE_SCALE) or null; `nowMs` the seat's clock.
 */
export function marketJson({ roundHex, contract, manifest, window, feeBps, levels, outcome, last, nowMs, rounds = null }) {
  const m = marketOfRound(manifest, contract);
  const endMs = window ? window.endMs : contract.entryCloseMs;
  const startMs = window ? window.startMs : contract.startTimeMs;
  const closed = BigInt(nowMs) >= contract.entryCloseMs;
  const opensMs = window && window.startMs > contract.committeeTimeMs ? window.startMs : contract.committeeTimeMs;
  const accepting = BigInt(nowMs) >= opensMs && !closed;
  const won = outcome && outcome.state === 'ATTESTED' && Number.isInteger(outcome.outcome) ? outcome.outcome : null;
  const tokens = [YES, NO].map((o) => {
    const q = quoteOf(levels, o, last);
    return { token_id: tokenIdOf(roundHex, o), outcome: m.outcomes[o], price: Number(q.mid !== null ? priceDecimal(q.mid) : '0.5'), winner: won === o };
  });
  return {
    enable_order_book: true, active: true, closed, archived: false, accepting_orders: accepting,
    accepting_order_timestamp: iso(opensMs), minimum_order_size: Number(MIN_SHARES), minimum_tick_size: Number(TICK_SIZE),
    condition_id: conditionIdOf(roundHex), question_id: conditionIdOf(roundHex), question: questionOf(manifest, contract, window),
    description: (m.marketTerms && m.marketTerms.sourceRule) || `A ${manifest.gameName} market of Bitcoin Arena: ${m.outcomes.join(' or ')}; one share pays 1 sat.`,
    market_slug: slugOf(manifest, window, roundHex), end_date_iso: iso(endMs), game_start_time: iso(startMs), seconds_delay: 0, fpmm: '', icon: '', image: '',
    maker_base_fee: feeBps, taker_base_fee: feeBps, notifications_enabled: false, neg_risk: false, neg_risk_market_id: '', neg_risk_request_id: '',
    is_50_50_outcome: false, rewards: { rates: null, min_size: 0, max_spread: 0 }, tags: ['Crypto', 'Bitcoin', 'Bitcoin Arena'],
    tokens,
    // ARENA'S OWN, beside Polymarket's fields (a stock client ignores them): the round, its seats, its state, and where the orders go
    arena: { round: roundHex, game: manifest.gameName, outcome: outcome ? outcome.state : 'OPEN', entryCloseMs: String(contract.entryCloseMs),
      federation: toHex(contract.federationId), seats: rounds ? rounds : contract.nodes.length, feeBps },
  };
}

/** Gamma's market row (GET /events, /gamma/markets): the same market as the Gamma API lists it - strings of JSON for the arrays. */
export function gammaMarketJson(cm) {
  const prices = cm.tokens.map((t) => String(t.price));
  return { id: cm.condition_id, question: cm.question, conditionId: cm.condition_id, slug: cm.market_slug, description: cm.description,
    endDate: cm.end_date_iso, startDate: cm.game_start_time, outcomes: JSON.stringify(cm.tokens.map((t) => t.outcome)), outcomePrices: JSON.stringify(prices),
    clobTokenIds: JSON.stringify(cm.tokens.map((t) => t.token_id)), active: cm.active, closed: cm.closed, archived: false, acceptingOrders: cm.accepting_orders,
    enableOrderBook: true, orderPriceMinTickSize: cm.minimum_tick_size, orderMinSize: cm.minimum_order_size, negRisk: false, liquidity: '0', volume: '0',
    makerBaseFee: cm.maker_base_fee, takerBaseFee: cm.taker_base_fee, arena: cm.arena };
}
/** Gamma's event: one per market here (an Up/Down window is its own event, as on Polymarket). */
export function eventJson(cm) {
  return { id: cm.condition_id, ticker: cm.market_slug, slug: cm.market_slug, title: cm.question, description: cm.description,
    startDate: cm.game_start_time, endDate: cm.end_date_iso, active: cm.active, closed: cm.closed, archived: false, markets: [gammaMarketJson(cm)],
    tags: cm.tags.map((label, i) => ({ id: String(i + 1), label, slug: label.toLowerCase().replace(/\s+/g, '-') })) };
}

// ---- THE BOOK ----
/**
 * THE LEVELS OF ONE TOKEN from the ledger's resting orders. A buy of outcome o at p is a bid of o at p; a buy of the other outcome at q
 * is an ask of o at 1 - q (a YES buyer at 0.6 and a NO buyer at 0.4 fund one complete set - order-book.js); a sell of o is an ask of o,
 * a sell of the other outcome at q a bid of o at 1 - q. Sizes in msat of payout, summed per price. Answers { bids, asks } as
 * [{ price (BigInt), sizeMsat }] - bids ascending, asks descending (best last, as Polymarket's /book orders them).
 */
export function tokenLevels(levels, outcome) {
  const bids = new Map(), asks = new Map();
  const add = (m, price, size) => m.set(price, (m.get(price) || 0n) + size);
  for (const b of (levels && levels.buys) || []) {
    const price = BigInt(b.price), size = buyShares(b.netMsat, price);
    if (size <= 0n) continue;
    if (Number(b.outcome) === outcome) add(bids, price, size); else add(asks, PRICE_SCALE - price, size);
  }
  for (const s of (levels && levels.sells) || []) {
    const price = BigInt(s.price), size = BigInt(s.sharesMsat);
    if (size <= 0n) continue;
    if (Number(s.outcome) === outcome) add(asks, price, size); else add(bids, PRICE_SCALE - price, size);
  }
  const rows = (m, dir) => [...m].map(([price, sizeMsat]) => ({ price, sizeMsat })).sort((a, b) => (a.price < b.price ? -dir : a.price > b.price ? dir : 0));
  return { bids: rows(bids, 1), asks: rows(asks, -1) };
}
/** Best bid, best ask, mid and spread of a token (PRICE_SCALE BigInts, null where the side is empty); `last` the last clearing price (YES). */
export function quoteOf(levels, outcome, last = null) {
  const { bids, asks } = tokenLevels(levels, outcome);
  const bid = bids.length ? bids[bids.length - 1].price : null, ask = asks.length ? asks[asks.length - 1].price : null;
  const lastOf = last === null || last === undefined ? null : (outcome === YES ? BigInt(last) : PRICE_SCALE - BigInt(last));
  const mid = bid !== null && ask !== null ? (bid + ask) / 2n : bid !== null ? bid : ask !== null ? ask : lastOf;
  return { bid, ask, mid, spread: bid !== null && ask !== null ? ask - bid : null, last: lastOf };
}
/** GET /book?token_id= : Polymarket's OrderBookSummary. */
export function bookJson({ roundHex, outcome, levels, last, nowMs }) {
  const { bids, asks } = tokenLevels(levels, outcome);
  const row = (x) => ({ price: priceDecimal(x.price), size: sharesDecimal(x.sizeMsat) });
  const q = quoteOf(levels, outcome, last);
  const body = { market: conditionIdOf(roundHex), asset_id: tokenIdOf(roundHex, outcome), timestamp: String(nowMs), hash: '',
    bids: bids.map(row), asks: asks.map(row), min_order_size: String(MIN_SHARES), tick_size: TICK_SIZE, neg_risk: false,
    last_trade_price: q.last === null ? '' : priceDecimal(q.last) };
  body.hash = toHex(sha256(new TextEncoder().encode(JSON.stringify(body)))).slice(0, 40);
  return body;
}

// ---- TRADES AND HISTORY ----
/**
 * THE TRADES OF A MARKET from its certified batches (orderBook.cleared(rid).batches: [{ k, price, fills, batchId }], each fill
 * { id, outcome, payoutMsat, costMsat, sell? }), oldest first. A buy fill of outcome o: a BUY of token o at the batch's price for o;
 * a sell fill: a SELL. `cutoffMs(k)` the batch's time. Each as the Data API lists a trade (GET /trades?market=).
 */
export function tradesOf({ roundHex, batches, cutoffMs, outcomes, question, slug }) {
  const out = [];
  for (const b of batches || []) {
    if (b.price === null || b.price === undefined) continue;
    const price = BigInt(b.price), at = Math.floor(Number(cutoffMs(b.k)) / 1000);
    for (const f of b.fills || []) {
      const payout = BigInt(f.payoutMsat || 0n);
      if (payout <= 0n) continue;
      const o = Number(f.outcome);
      out.push({ proxyWallet: '', side: f.sell ? 'SELL' : 'BUY', asset: tokenIdOf(roundHex, o), conditionId: conditionIdOf(roundHex),
        size: Number(sharesDecimal(payout)), price: Number(priceDecimal(o === YES ? price : PRICE_SCALE - price)), timestamp: at,
        title: question, slug, icon: '', eventSlug: slug, outcome: outcomes[o], outcomeIndex: o, name: '', pseudonym: '', bio: '', profileImage: '', profileImageOptimized: '',
        transactionHash: `0x${String(b.batchId || '').padEnd(64, '0').slice(0, 64)}`, arena: { batch: String(b.k), order: orderIdOf(f.id), fill: f.sell ? 'sell' : 'buy' } });
    }
  }
  return out;
}
/** The CLOB's trade row (GET /data/trades) of a Data API trade. */
export function clobTradeOf(t) {
  return { id: `${t.transactionHash}-${t.arena.order.slice(2, 18)}`, taker_order_id: t.arena.order, market: t.conditionId, asset_id: t.asset, side: t.side,
    size: String(t.size), fee_rate_bps: '0', price: String(t.price), status: 'CONFIRMED', match_time: String(t.timestamp), last_update: String(t.timestamp),
    outcome: t.outcome, bucket_index: 0, owner: '', maker_address: '', transaction_hash: t.transactionHash, maker_orders: [], trader_side: 'TAKER' };
}
const SPANS = { '1m': 60, '1h': 3600, '6h': 6 * 3600, '1d': 86400, '1w': 7 * 86400 };
/**
 * GET /prices-history?market=<token_id>&interval=&fidelity=&startTs=&endTs= : { history: [{ t (unix s), p }] } - the clearing price of
 * every certified batch for that token, within the span, one point per `fidelity` minutes (the last of each bucket).
 */
export function historyOf({ batches, cutoffMs, outcome, interval = 'max', fidelity = 0, startTs = null, endTs = null, nowMs }) {
  const now = Math.floor(Number(nowMs) / 1000);
  let from = startTs !== null ? Number(startTs) : interval in SPANS ? now - SPANS[interval] : 0;
  const to = endTs !== null ? Number(endTs) : now + 1;
  if (!Number.isFinite(from)) from = 0;
  const pts = [];
  for (const b of batches || []) {
    if (b.price === null || b.price === undefined) continue;
    const t = Math.floor(Number(cutoffMs(b.k)) / 1000);
    if (t < from || t > to) continue;
    const price = BigInt(b.price);
    pts.push({ t, p: Number(priceDecimal(outcome === YES ? price : PRICE_SCALE - price)) });
  }
  const step = Math.max(0, Number(fidelity) || 0) * 60;
  if (step <= 0) return { history: pts };
  const buckets = new Map();
  for (const x of pts) buckets.set(Math.floor(x.t / step) * step, x.p);
  return { history: [...buckets].map(([t, p]) => ({ t, p })) };
}

// ---- ORDERS ----
/**
 * A POLYMARKET ORDER BODY READ AS AN ARENA ORDER (POST /order: { order: { salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 * expiration, nonce, feeRateBps, side, signatureType, signature }, owner, orderType, postOnly }). Amounts carry 6 decimals (USDC and
 * conditional tokens); a BUY makes collateral and takes shares, a SELL the other way, so the price is collateral / shares. Answers
 * { ok, token, outcome, candidates, side, price (PRICE_SCALE), priceDecimal, shares (BigInt), sharesMsat, expiryMs, orderType,
 * netMsat (shares x price: the budget a buy spends) } or { ok: false, why } - a stock client's first mistake named, not guessed at.
 */
export function parseOrder(body) {
  const o = body && body.order;
  if (!o || typeof o !== 'object') return { ok: false, why: 'an order is { order: {...}, owner, orderType }' };
  const tr = tokenRound(o.tokenId);
  if (!tr) return { ok: false, why: `tokenId ${String(o.tokenId).slice(0, 40)} is not a Bitcoin Arena token: GET /markets lists them` };
  const side = o.side === 0 || o.side === '0' || String(o.side).toUpperCase() === 'BUY' ? 'BUY' : o.side === 1 || o.side === '1' || String(o.side).toUpperCase() === 'SELL' ? 'SELL' : null;
  if (!side) return { ok: false, why: 'side is BUY (0) or SELL (1)' };
  if (!/^[0-9]{1,30}$/.test(String(o.makerAmount)) || !/^[0-9]{1,30}$/.test(String(o.takerAmount))) return { ok: false, why: 'makerAmount and takerAmount are integer strings with 6 decimals' };
  const maker = BigInt(o.makerAmount), taker = BigInt(o.takerAmount);
  const collateral = side === 'BUY' ? maker : taker, sharesRaw = side === 'BUY' ? taker : maker;
  if (sharesRaw <= 0n || collateral <= 0n) return { ok: false, why: 'an order names a positive size and a positive amount' };
  // the price to the cent: collateral / shares, both in 6 decimals
  const cents = Number((collateral * 100n + sharesRaw / 2n) / sharesRaw);
  if (cents < 1 || cents > 99) return { ok: false, why: `a price is 0.01 to 0.99: this order's is ${(Number(collateral) / Number(sharesRaw)).toFixed(4)}` };
  const price = BigInt(cents) * TICK;
  const shares = sharesRaw / 1000000n;   // whole shares; 6 decimals dropped (a share is 1 sat here, and a sat does not split)
  if (shares < MIN_SHARES) return { ok: false, why: `an order buys at least ${MIN_SHARES} shares: ${sharesDecimal(sharesRaw * SHARE_MSAT / 1000000n)} is too few` };
  const orderType = String(body.orderType || 'GTC').toUpperCase();
  if (!['GTC', 'GTD', 'FOK', 'FAK'].includes(orderType)) return { ok: false, why: 'orderType is GTC, GTD, FOK or FAK' };
  const expiration = Number(o.expiration || 0);
  const expiryMs = orderType === 'GTD' && expiration > 0 ? BigInt(expiration) * 1000n : 0n;
  const sharesMsat = shares * SHARE_MSAT;
  return { ok: true, token: String(o.tokenId), outcome: tr.outcome, candidates: tr.candidates, side, price, priceDecimal: priceDecimal(price), shares, sharesMsat,
    netMsat: (sharesMsat * price) / PRICE_SCALE, expiryMs, orderType, postOnly: !!body.postOnly, maker: o.maker ? String(o.maker) : '', salt: o.salt !== undefined ? String(o.salt) : '',
    nonce: o.nonce !== undefined ? String(o.nonce) : '0' };
}
/** The stake an Arena order brings for a budget of `netMsat` after a fee of `feeBps` out of the stake: the least whole msat that leaves the budget. */
export function stakeForNet(netMsat, feeBps) {
  const n = BigInt(netMsat), bps = BigInt(feeBps);
  if (bps <= 0n) return n;
  return (n * 10000n + (10000n - bps) - 1n) / (10000n - bps);
}

/**
 * ONE OPEN ORDER AS THE CLOB LISTS IT (GET /data/orders, /data/order/{id}): from the entry, the ledger's position of it, the batch it
 * is in and when this seat took it. `status`: LIVE (resting), MATCHED (its budget spent), CANCELED, UNMATCHED (the market closed on it
 * unfilled), DELAYED (taken here, not in a certified batch yet).
 */
export function orderJson({ roundHex, entryHex, entry, position, resting, batch, receivedMs, closed, outcomes }) {
  const o = Number(entry.pick), price = BigInt(entry.limitPrice);
  const net = entry.stakeMsat - entry.feeMsat - (entry.donationMsat || 0n);
  const original = buyShares(net, price);
  const matched = position ? BigInt(position.shares[o]) : 0n;
  const cancelled = !!(position && position.cancelled);
  const status = cancelled ? 'CANCELED' : batch === null || batch === undefined ? 'DELAYED' : resting ? 'LIVE' : matched > 0n ? 'MATCHED' : closed ? 'UNMATCHED' : 'LIVE';
  return { id: orderIdOf(entryHex), status, owner: '', maker_address: `0x${toHex(entry.playerPubkey)}`, market: conditionIdOf(roundHex), asset_id: tokenIdOf(roundHex, o),
    side: 'BUY', original_size: sharesDecimal(original), size_matched: sharesDecimal(matched), price: priceDecimal(price), associate_trades: [],
    outcome: outcomes[o], created_at: Math.floor(Number(receivedMs || 0) / 1000), expiration: String(entry.orderExpiryMs ? entry.orderExpiryMs / 1000n : 0n),
    order_type: entry.orderExpiryMs ? 'GTD' : 'GTC', arena: { entry: entryHex, round: roundHex, stakeMsat: String(entry.stakeMsat), feeMsat: String(entry.feeMsat), batch: batch === null || batch === undefined ? null : String(batch) } };
}
/** A position as the Data API lists it (GET /positions?user=): an entry's shares of each side it holds. */
export function positionJson({ roundHex, entryHex, entry, position, outcome, quote, outcomes, endIso, question, slug }) {
  const rows = [];
  for (const o of [YES, NO]) {
    const held = BigInt(position.shares[o]) - BigInt(position.shares[1 - o]);
    if (held <= 0n) continue;
    const cost = o === Number(entry.pick) ? BigInt(position.cost) : 0n;
    const avg = held > 0n && cost > 0n ? Number(cost) / Number(held) : Number(priceDecimal(BigInt(entry.limitPrice)));
    const cur = quote(o);
    const won = outcome && outcome.state === 'ATTESTED' ? (outcome.outcome === o ? 1 : 0) : null;
    const curPrice = won !== null ? won : cur === null ? avg : Number(priceDecimal(cur));
    const size = Number(sharesDecimal(held));
    rows.push({ proxyWallet: `0x${toHex(entry.playerPubkey)}`, asset: tokenIdOf(roundHex, o), conditionId: conditionIdOf(roundHex), size, avgPrice: Number(avg.toFixed(4)),
      initialValue: Number((size * avg).toFixed(3)), currentValue: Number((size * curPrice).toFixed(3)), cashPnl: Number((size * (curPrice - avg)).toFixed(3)),
      percentPnl: avg > 0 ? Number((((curPrice - avg) / avg) * 100).toFixed(2)) : 0, totalBought: size, realizedPnl: 0, percentRealizedPnl: 0, curPrice, redeemable: won !== null,
      mergeable: false, title: question, slug, icon: '', eventSlug: slug, outcome: outcomes[o], outcomeIndex: o, oppositeOutcome: outcomes[1 - o], oppositeAsset: tokenIdOf(roundHex, 1 - o),
      endDate: endIso, negativeRisk: false, arena: { entry: entryHex, order: orderIdOf(entryHex) } });
  }
  return rows;
}

// ---- THE ROUTER ----
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, poly_address, poly_signature, poly_timestamp, poly_nonce, poly_api_key, poly_passphrase' };
const WRITE_WHY = 'this seat holds no player\'s keys or e-cash: orders are placed by the Arena CLOB adapter beside your bot '
  + '(packages/arena-node/tools/polymarket-adapter.mjs; https://docs.bitcoin-arena.io/#polymarket) - point the client at it, it points at the seats';

/**
 * THE ROUTER. `ctx`: { round (the store: get, entry, entriesOf, cancelled, pubkey, now, db), orderBook (OrderBook), hosted (plugins),
 * listRounds: async () => [round hex] (the announced rounds, GET /rounds), marketWindowFor(c), outcomeOf(rid, c), version }.
 * `handle(req, res, url)` answers every path under BASE and returns true; false for any other path.
 */
export function createPolymarketRouter(ctx) {
  const { round, orderBook } = ctx;
  const now = () => Number(round.now());
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }); res.end(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? String(v) : v))); return true; };
  const fail = (res, code, why) => json(res, code, { error: why });
  // THE MARKETS THIS SEAT HOLDS: the announced rounds that are two-outcome markets here plus the rounds that took orders lately -
  // listed at most every 5 s (a bot polls; the listing is the seat's own GET /rounds work)
  let listing = { at: 0, hexes: [] };
  async function marketHexes() {
    if (now() - listing.at < 5000 && listing.hexes.length) return listing.hexes;
    const set = new Set();
    try { for (const h of await ctx.listRounds()) set.add(h); } catch { /* the recent rounds still list */ }
    for (const r of orderBook.recentRounds(0, now())) set.add(r.round);
    const hexes = [...set].filter((h) => { const x = marketOf(h); return !!x; });
    listing = { at: now(), hexes };
    return hexes;
  }
  /** A market round this seat hosts, whole: its contract, manifest, rates, window, ledger - or null. */
  function marketOf(hex) {
    if (!isHex64(hex)) return null;
    const rid = fromHex(hex);
    const m = orderBook.market(rid);
    if (!m.ok) return null;
    const window = ctx.marketWindowFor ? ctx.marketWindowFor(m.contract) : null;
    return { hex, rid, contract: m.contract, manifest: m.manifest, feeBps: m.feeBps, window, outcomes: marketOfRound(m.manifest, m.contract).outcomes,
      cutoffMs: (k) => orderBook.cutoffOf(k) };
  }
  const ledgerOf = (x) => { const L = orderBook.cleared(x.rid); return L.ok ? L : { batches: [], positions: [], resting: { buys: [], sells: [] }, levels: { buys: [], sells: [] } }; };
  const lastOf = (L) => { const priced = (L.batches || []).filter((b) => b.price !== null && b.price !== undefined); return priced.length ? priced[priced.length - 1].price : null; };
  const outcomeOf = (x) => { try { return ctx.outcomeOf ? ctx.outcomeOf(x.rid, x.contract) : null; } catch { return null; } };
  const clobMarket = (x) => { const L = ledgerOf(x); return marketJson({ roundHex: x.hex, contract: x.contract, manifest: x.manifest, window: x.window, feeBps: x.feeBps,
    levels: L.levels, outcome: outcomeOf(x), last: lastOf(L), nowMs: now(), rounds: x.contract.nodes.length }); };
  /** The market and outcome a token names, from the round held. */
  function tokenOf(tokenId) {
    const tr = tokenRound(tokenId);
    if (!tr) return null;
    for (const h of tr.candidates) { const x = marketOf(h); if (x) return { ...x, outcome: tr.outcome }; }
    return null;
  }
  const tradesFor = (x) => { const L = ledgerOf(x); return tradesOf({ roundHex: x.hex, batches: L.batches, cutoffMs: x.cutoffMs, outcomes: x.outcomes,
    question: questionOf(x.manifest, x.contract, x.window), slug: slugOf(x.manifest, x.window, x.hex) }); };
  /** Every order of a market as the CLOB lists them, with the ledger. */
  function ordersFor(x, { open = null, maker = null } = {}) {
    const L = ledgerOf(x);
    const pos = new Map((L.positions || []).map((p) => [p.entry, p]));
    const resting = new Set((L.resting && L.resting.buys) || []);
    const closed = now() >= Number(x.contract.entryCloseMs);
    const rows = [];
    for (const { entryId, entry } of round.entriesOf(x.rid)) {
      if (entry.limitPrice === undefined || entry.limitPrice === null) continue;
      const eh = toHex(entryId);
      if (maker && toHex(entry.playerPubkey) !== maker) continue;
      const row = round.db.prepare('SELECT received_ms, batch FROM market_orders WHERE order_id = ?').get(eh);
      const o = orderJson({ roundHex: x.hex, entryHex: eh, entry, position: pos.get(eh) || null, resting: resting.has(eh), batch: row ? row.batch : null,
        receivedMs: row ? row.received_ms : 0, closed, outcomes: x.outcomes });
      if (open === true && !['LIVE', 'DELAYED'].includes(o.status)) continue;
      rows.push(o);
    }
    return rows;
  }
  const page = (data) => ({ data, next_cursor: END_CURSOR, limit: data.length, count: data.length });
  const param = (url, k) => url.searchParams.get(k);
  // A CLOSED MARKET HAS NO BOOK (kanban #736, measured on Polymarket 2026-10-28 by the second helper's run, btc-updown-15m-1793140200
  // resolved: /book, /price, /midpoint and /spread answered 404 "No orderbook exists for the requested token id", /last-trade-price still
  // 200): here the same once the market's entries closed - a stock bot that walks markets drops it as it drops a resolved one
  const NO_BOOK = 'No orderbook exists for the requested token id';
  const liveTokenParam = (url, res) => {
    const x = tokenOf(param(url, 'token_id'));
    if (!x || now() >= Number(x.contract.entryCloseMs)) { fail(res, 404, NO_BOOK); return null; }
    return x;
  };
  const tokenParam = (url, res) => { const x = tokenOf(param(url, 'token_id')); if (!x) fail(res, 404, `no market of token_id ${String(param(url, 'token_id') || '').slice(0, 40)} is held here: GET ${BASE}/markets lists them`); return x; };

  async function handle(req, res, url) {
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
    const path = url.pathname.slice(BASE.length) || '/';
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    // A BODY READ BEFORE ANY ANSWER (a request body left unread resets the client's kept-alive connection): the one door that uses it
    // (POST /books) reads it here too
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') { try { body = Buffer.from(await ctx.read(req)).toString('utf8'); } catch { body = ''; } }
    // THE CLIENT'S FIRST CALLS: health and time
    if (path === '/' || path === '/ok') return json(res, 200, 'OK');
    if (path === '/time') return json(res, 200, Math.floor(now() / 1000));
    if (req.method === 'GET' && (path === '/markets' || path === '/simplified-markets' || path === '/sampling-markets' || path === '/sampling-simplified-markets')) {
      const data = [];
      for (const h of await marketHexes()) { const x = marketOf(h); if (x) data.push(clobMarket(x)); }
      data.sort((a, b) => (a.end_date_iso < b.end_date_iso ? -1 : 1));
      return json(res, 200, page(path.includes('simplified') ? data.map((m) => ({ condition_id: m.condition_id, tokens: m.tokens, rewards: m.rewards, min_incentive_size: '0', max_incentive_spread: '0', active: m.active, closed: m.closed, arena: m.arena })) : data));
    }
    if (req.method === 'GET' && path.startsWith('/markets/')) {
      const x = marketOf(roundOfCondition(path.slice('/markets/'.length)));
      return x ? json(res, 200, clobMarket(x)) : fail(res, 404, 'no such market is held here: condition_id is 0x + the round id');
    }
    // GAMMA'S LISTING (events and markets), for a bot that discovers markets there
    if (req.method === 'GET' && (path === '/events' || path === '/gamma/markets' || path === '/gamma/events')) {
      const data = [];
      for (const h of await marketHexes()) { const x = marketOf(h); if (x) data.push(clobMarket(x)); }
      const active = param(url, 'active'), closed = param(url, 'closed');
      const kept = data.filter((m) => (active === null || String(m.active) === active) && (closed === null || String(m.closed) === closed))
        .sort((a, b) => (a.end_date_iso < b.end_date_iso ? -1 : 1)).slice(0, Math.min(500, Number(param(url, 'limit') || 100) || 100));
      return json(res, 200, path === '/gamma/markets' ? kept.map(gammaMarketJson) : kept.map(eventJson));
    }
    if (req.method === 'GET' && path === '/book') {
      const x = liveTokenParam(url, res); if (!x) return true;
      const L = ledgerOf(x);
      return json(res, 200, bookJson({ roundHex: x.hex, outcome: x.outcome, levels: L.levels, last: lastOf(L), nowMs: now() }));
    }
    if (req.method === 'POST' && path === '/books') {
      let asked; try { asked = JSON.parse(body || '[]'); } catch { return fail(res, 400, 'a body of [{ token_id }]'); }
      const out = [];
      for (const b of Array.isArray(asked) ? asked : []) { const x = tokenOf(b && b.token_id); if (!x || now() >= Number(x.contract.entryCloseMs)) continue; const L = ledgerOf(x); out.push(bookJson({ roundHex: x.hex, outcome: x.outcome, levels: L.levels, last: lastOf(L), nowMs: now() })); }
      return json(res, 200, out);
    }
    if (req.method === 'GET' && (path === '/price' || path === '/midpoint' || path === '/spread' || path === '/last-trade-price')) {
      const x = path === '/last-trade-price' ? tokenParam(url, res) : liveTokenParam(url, res); if (!x) return true;
      const L = ledgerOf(x), q = quoteOf(L.levels, x.outcome, lastOf(L));
      const dec = (v) => (v === null ? '' : priceDecimal(v));
      if (path === '/midpoint') return json(res, 200, { mid: dec(q.mid) });
      if (path === '/spread') return json(res, 200, { spread: dec(q.spread) });
      if (path === '/last-trade-price') return json(res, 200, { price: dec(q.last), side: 'BUY' });
      const side = String(param(url, 'side') || 'BUY').toUpperCase();
      // Polymarket's /price: side=BUY is the best ask (what a buyer pays), side=SELL the best bid
      return json(res, 200, { price: dec(side === 'SELL' ? q.bid : q.ask) });
    }
    if (req.method === 'GET' && (path === '/tick-size' || path === '/neg-risk' || path === '/fee-rate')) {
      const x = tokenParam(url, res); if (!x) return true;
      return json(res, 200, path === '/tick-size' ? { minimum_tick_size: TICK_SIZE } : path === '/neg-risk' ? { neg_risk: false } : { fee_rate_bps: x.feeBps });
    }
    if (req.method === 'GET' && path === '/prices-history') {
      const x = tokenOf(param(url, 'market'));
      if (!x) return fail(res, 404, 'market=<token_id> names a token this seat holds no market of');
      const L = ledgerOf(x);
      const num = (k) => (param(url, k) === null ? null : Number(param(url, k)));
      return json(res, 200, historyOf({ batches: L.batches, cutoffMs: x.cutoffMs, outcome: x.outcome, interval: param(url, 'interval') || 'max', fidelity: num('fidelity') || 0,
        startTs: num('startTs'), endTs: num('endTs'), nowMs: now() }));
    }
    // TRADES: the Data API's (GET /trades?market=|asset_id=), the CLOB's (GET /data/trades, a page), and a market's live activity
    if (req.method === 'GET' && (path === '/trades' || path === '/data/trades' || path.startsWith('/live-activity/events/'))) {
      let xs = [];
      const cond = path.startsWith('/live-activity/events/') ? path.slice('/live-activity/events/'.length) : param(url, 'market');
      if (cond) { const x = marketOf(roundOfCondition(cond)) || tokenOf(cond); if (x) xs = [x]; }
      else if (param(url, 'asset_id')) { const x = tokenOf(param(url, 'asset_id')); if (x) xs = [x]; }
      else for (const h of await marketHexes()) { const x = marketOf(h); if (x) xs.push(x); }
      let trades = xs.flatMap(tradesFor);
      if (param(url, 'asset_id')) trades = trades.filter((t) => t.asset === param(url, 'asset_id'));
      trades.sort((a, b) => b.timestamp - a.timestamp);
      const limit = Math.min(1000, Number(param(url, 'limit') || 100) || 100);
      trades = trades.slice(Number(param(url, 'offset') || 0) || 0).slice(0, limit);
      return json(res, 200, path === '/data/trades' ? page(trades.map(clobTradeOf)) : trades);
    }
    // ORDERS AS THE SEAT HOLDS THEM: one by id, a market's (open=true for the resting ones), a maker's
    if (req.method === 'GET' && path.startsWith('/data/order/')) {
      const eh = entryOfOrderId(path.slice('/data/order/'.length));
      const raw = eh ? round.entry(fromHex(eh)) : null;
      if (!raw) return fail(res, 404, 'this seat holds no such order: an order id is 0x + the entry id');
      const entry = decodeEntryContract(raw);
      const x = marketOf(toHex(entry.roundId));
      if (!x) return fail(res, 404, 'that entry is not an order of a market held here');
      const o = ordersFor(x).find((r) => r.arena.entry === eh);
      return o ? json(res, 200, o) : fail(res, 404, 'that entry is not an order (it names no limit price)');
    }
    if (req.method === 'GET' && (path === '/data/orders' || path === '/orders')) {
      const maker = String(param(url, 'maker_address') || param(url, 'maker') || '').toLowerCase().replace(/^0x/, '') || null;
      let xs = [];
      if (param(url, 'market')) { const x = marketOf(roundOfCondition(param(url, 'market'))); if (x) xs = [x]; }
      else if (param(url, 'asset_id')) { const x = tokenOf(param(url, 'asset_id')); if (x) xs = [x]; }
      else for (const h of await marketHexes()) { const x = marketOf(h); if (x) xs.push(x); }
      let rows = xs.flatMap((x) => ordersFor(x, { open: param(url, 'all') === '1' ? null : true, maker }));
      if (param(url, 'asset_id')) rows = rows.filter((r) => r.asset_id === param(url, 'asset_id'));
      if (param(url, 'id')) rows = rows.filter((r) => r.id === param(url, 'id'));
      return json(res, 200, page(rows));
    }
    if (req.method === 'GET' && path === '/positions') {
      const user = String(param(url, 'user') || '').toLowerCase().replace(/^0x/, '');
      if (!user) return fail(res, 400, 'GET /positions?user=<0x + the player key or an entry id>[&market=]');
      let xs = [];
      if (param(url, 'market')) { const x = marketOf(roundOfCondition(param(url, 'market'))); if (x) xs = [x]; }
      else for (const h of await marketHexes()) { const x = marketOf(h); if (x) xs.push(x); }
      const rows = [];
      for (const x of xs) {
        const L = ledgerOf(x), last = lastOf(L), outcome = outcomeOf(x);
        const quote = (o) => quoteOf(L.levels, o, last).mid;
        for (const p of L.positions || []) {
          if (!positionFilled({ ...p, shares: p.shares.map(BigInt), cost: BigInt(p.cost), sellDebt: BigInt(p.sellDebt) })) continue;
          const raw = round.entry(fromHex(p.entry)); if (!raw) continue;
          const entry = decodeEntryContract(raw);
          if (toHex(entry.playerPubkey) !== user && p.entry !== user) continue;
          rows.push(...positionJson({ roundHex: x.hex, entryHex: p.entry, entry, position: { ...p, shares: p.shares.map(BigInt), cost: BigInt(p.cost) }, outcome, quote, outcomes: x.outcomes,
            endIso: iso(x.window ? x.window.endMs : x.contract.entryCloseMs), question: questionOf(x.manifest, x.contract, x.window), slug: slugOf(x.manifest, x.window, x.hex) }));
        }
      }
      return json(res, 200, rows);
    }
    // WHAT A SEAT CANNOT DO (the file's head): the writing half and the key doors, answered by name in Polymarket's error shape
    if (['/order', '/orders', '/cancel-all', '/cancel-market-orders'].includes(path) && (req.method === 'POST' || req.method === 'DELETE'))
      return json(res, 501, { success: false, errorMsg: WRITE_WHY, status: 'adapter', orderID: '' });
    if (path.startsWith('/auth/') || path.startsWith('/balance-allowance') || path === '/notifications' || path.startsWith('/order-scoring') || path.startsWith('/orders-scoring') || path.startsWith('/rfq/') || path.startsWith('/v1/heartbeats'))
      return json(res, 501, { error: WRITE_WHY });
    return fail(res, 404, `no such door under ${BASE}: markets, markets/{condition_id}, simplified-markets, events, book, books, price, midpoint, spread, last-trade-price, tick-size, neg-risk, fee-rate, prices-history, trades, data/trades, data/orders, data/order/{id}, positions`);
  }
  return { handle, marketOf, tokenOf, ordersFor, tradesFor, marketHexes };
}
