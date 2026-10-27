// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE POLYMARKET SHAPES, PURE (kanban #736): a round is a market with two tokens whose ids read back to the round; prices and
// sizes in Polymarket's decimals; the book of one token from the ledger's resting orders (the other side's buys as asks); the trades
// and the price history from certified batches; and a py-clob-client order body read as an Arena order - or refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenIdOf, tokenRound, conditionIdOf, roundOfCondition, priceDecimal, priceFromDecimal, sharesDecimal, tokenLevels, quoteOf, bookJson,
  marketJson, gammaMarketJson, eventJson, tradesOf, clobTradeOf, historyOf, parseOrder, stakeForNet, orderJson, questionOf, END_CURSOR } from '../src/polymarket.js';
import { UPDOWN } from './plugins/updown/index.js';
import { PRICE_SCALE, YES, NO } from '../../arena-protocol/src/order-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = 'a3f1'.repeat(16);                       // a round id ending in an odd nibble (lowest bit 1)
const RID_EVEN = 'a3f0'.repeat(16);
const CLOSE = 1791599400000n;                         // on the 15-minute grid
const contract = { entryCloseMs: CLOSE, committeeTimeMs: CLOSE - 1800000n, startTimeMs: CLOSE - 900000n, nodes: [b32(1), b32(2), b32(3)], federationId: b32(0xfe) };
const window = { startMs: CLOSE - 900000n, endMs: CLOSE, periodMs: 900000n };
const manifest = UPDOWN.registration.manifest;
// the ledger's levels: Up buys at 0.60 for 600 sat (1000 shares) and 0.55 for 110 sat (200 shares); a Down buy at 0.45 for 90 sat (200 shares);
// a resting sell of 50 Up shares at 0.70
const levels = { buys: [{ outcome: YES, price: 60000n, netMsat: 600000n, expiryMs: 0n }, { outcome: YES, price: 55000n, netMsat: 110000n, expiryMs: 0n }, { outcome: NO, price: 45000n, netMsat: 90000n, expiryMs: 0n }],
  sells: [{ outcome: YES, price: 70000n, sharesMsat: 50000n }] };

test('ids: a token is the round with its lowest bit set to the outcome, read back without a table; a condition id is 0x + the round', () => {
  for (const rid of [RID, RID_EVEN]) for (const o of [YES, NO]) {
    const t = tokenIdOf(rid, o);
    assert.match(t, /^[0-9]+$/);
    assert.ok(BigInt(t) < 1n << 256n, 'a token fits a uint256');
    const back = tokenRound(t);
    assert.equal(back.outcome, o);
    assert.ok(back.candidates.includes(rid), `the round is among the token's two candidates`);
  }
  assert.notEqual(tokenIdOf(RID, YES), tokenIdOf(RID, NO));
  assert.equal(tokenRound('abc'), null);
  assert.equal(tokenRound((1n << 256n).toString()), null);
  assert.equal(conditionIdOf(RID), `0x${RID}`);
  assert.equal(roundOfCondition(`0x${RID.toUpperCase()}`), RID);
  assert.equal(roundOfCondition('0x12'), null);
  console.log(`  TOKENS: Up ${tokenIdOf(RID, YES).slice(0, 12)}… Down ${tokenIdOf(RID, NO).slice(0, 12)}… of round ${RID.slice(0, 8)}`);
});

test('numbers: PRICE_SCALE prices as cent decimals and back, shares from msat', () => {
  assert.equal(priceDecimal(55000n), '0.55');
  assert.equal(priceDecimal(5000n), '0.05');
  assert.equal(priceDecimal(50500n), '0.505');
  assert.equal(priceDecimal(PRICE_SCALE), '1');
  assert.equal(priceFromDecimal('0.55'), 55000n);
  assert.equal(priceFromDecimal(0.734), 73000n);
  assert.equal(priceFromDecimal('1'), null);
  assert.equal(priceFromDecimal('0.001'), null);
  assert.equal(sharesDecimal(1000000n), '1000');
  assert.equal(sharesDecimal(1500n), '1.5');
});

test('the book of one token: its buys are bids, the other side\'s buys asks at 1 - price, its sells asks - sizes in shares, best last', () => {
  const up = tokenLevels(levels, YES);
  assert.deepEqual(up.bids.map((x) => [priceDecimal(x.price), sharesDecimal(x.sizeMsat)]), [['0.55', '200'], ['0.6', '1000']]);
  // the Down buy at 0.45 for 200 shares is an Up ask at 0.55; the Up sell at 0.70 an Up ask - asks descending, best (lowest) last
  assert.deepEqual(up.asks.map((x) => [priceDecimal(x.price), sharesDecimal(x.sizeMsat)]), [['0.7', '50'], ['0.55', '200']]);
  const down = tokenLevels(levels, NO);
  assert.deepEqual(down.bids.map((x) => [priceDecimal(x.price), sharesDecimal(x.sizeMsat)]), [['0.3', '50'], ['0.45', '200']]);
  assert.deepEqual(down.asks.map((x) => [priceDecimal(x.price), sharesDecimal(x.sizeMsat)]), [['0.45', '200'], ['0.4', '1000']]);
  const q = quoteOf(levels, YES, 58000n);
  assert.deepEqual([q.bid, q.ask, q.mid, q.spread, q.last], [60000n, 55000n, 57500n, -5000n, 58000n]);
  assert.equal(quoteOf(levels, NO, 58000n).last, 42000n);
  assert.equal(quoteOf({ buys: [], sells: [] }, YES, null).mid, null);
  const book = bookJson({ roundHex: RID, outcome: YES, levels, last: 58000n, nowMs: 1791599000000 });
  assert.equal(book.market, `0x${RID}`);
  assert.equal(book.asset_id, tokenIdOf(RID, YES));
  assert.deepEqual(Object.keys(book).sort(), ['asks', 'asset_id', 'bids', 'hash', 'last_trade_price', 'market', 'min_order_size', 'neg_risk', 'tick_size', 'timestamp']);
  assert.deepEqual(book.bids[1], { price: '0.6', size: '1000' });
  assert.deepEqual([book.min_order_size, book.tick_size, book.neg_risk, book.last_trade_price], ['5', '0.01', false, '0.58']);
  assert.match(book.hash, /^[0-9a-f]{40}$/);
  console.log(`  BOOK Up: bids ${JSON.stringify(book.bids)} asks ${JSON.stringify(book.asks)}`);
});

test('a round is a CLOB market: condition id, two tokens with mid prices, the window as start and end, open inside it and closed after; Gamma rows carry the same', () => {
  const inside = marketJson({ roundHex: RID, contract, manifest, window, feeBps: 100, levels, outcome: null, last: null, nowMs: Number(CLOSE) - 60000 });
  assert.equal(inside.condition_id, `0x${RID}`);
  assert.equal(inside.question, `BTC up at ${new Date(Number(CLOSE)).toISOString()}?`);
  assert.deepEqual(inside.tokens.map((t) => t.outcome), ['Up', 'Down']);
  assert.deepEqual(inside.tokens.map((t) => t.token_id), [tokenIdOf(RID, YES), tokenIdOf(RID, NO)]);
  assert.deepEqual(inside.tokens.map((t) => t.price), [0.575, 0.425]);
  assert.deepEqual(inside.tokens.map((t) => t.winner), [false, false]);
  assert.deepEqual([inside.active, inside.closed, inside.accepting_orders, inside.enable_order_book, inside.neg_risk], [true, false, true, true, false]);
  assert.equal(inside.end_date_iso, new Date(Number(CLOSE)).toISOString());
  assert.equal(inside.game_start_time, new Date(Number(CLOSE) - 900000).toISOString());
  assert.equal(inside.market_slug, `btc-updown-15m-${Number((CLOSE - 900000n) / 1000n)}`);
  assert.deepEqual([inside.minimum_order_size, inside.minimum_tick_size, inside.maker_base_fee], [5, 0.01, 100]);
  assert.equal(inside.arena.round, RID);
  // before the window: not accepting; after the close with Up attested: closed, Up the winner
  const before = marketJson({ roundHex: RID, contract, manifest, window, feeBps: 100, levels, outcome: null, last: null, nowMs: Number(CLOSE) - 1200000 });
  assert.deepEqual([before.active, before.closed, before.accepting_orders], [true, false, false]);
  const after = marketJson({ roundHex: RID, contract, manifest, window, feeBps: 100, levels: { buys: [], sells: [] }, outcome: { state: 'ATTESTED', outcome: 0 }, last: 61000n, nowMs: Number(CLOSE) + 60000 });
  assert.deepEqual([after.closed, after.accepting_orders, after.tokens.map((t) => t.winner), after.tokens.map((t) => t.price)], [true, false, [true, false], [0.61, 0.39]]);
  const g = gammaMarketJson(inside);
  assert.deepEqual([g.conditionId, g.outcomes, g.outcomePrices, JSON.parse(g.clobTokenIds).length], [`0x${RID}`, '["Up","Down"]', '["0.575","0.425"]', 2]);
  const ev = eventJson(inside);
  assert.deepEqual([ev.markets.length, ev.title, ev.endDate], [1, inside.question, inside.end_date_iso]);
  // a round with its own question (a template's) asks it; a market without a window asks its terms'
  assert.equal(questionOf(manifest, { ...contract, event: { question: 'Will it rain?', outcomes: ['Yes', 'No'], resolveAtMs: CLOSE } }, window), 'Will it rain?');
  console.log(`  MARKET: ${inside.question} tokens ${JSON.stringify(inside.tokens.map((t) => [t.outcome, t.price]))} ${inside.market_slug}`);
});

test('trades and price history from certified batches: a fill is a BUY of its token at the batch\'s price for that side; history per token, bucketed', () => {
  const batches = [
    { k: 10, batchId: 'b1'.repeat(32), price: 58000n, fills: [{ id: 'e1'.repeat(32), outcome: YES, payoutMsat: 200000n, costMsat: 116000n }, { id: 'e2'.repeat(32), outcome: NO, payoutMsat: 200000n, costMsat: 84000n }] },
    { k: 11, batchId: 'b2'.repeat(32), price: null, fills: [] },
    { k: 130, batchId: 'b3'.repeat(32), price: 60000n, fills: [{ id: 'e3'.repeat(32), outcome: YES, payoutMsat: 50000n, costMsat: 30000n, sell: true }] },
  ];
  const cutoffMs = (k) => (k + 1) * 500;
  const trades = tradesOf({ roundHex: RID, batches, cutoffMs, outcomes: ['Up', 'Down'], question: 'q', slug: 's' });
  assert.equal(trades.length, 3);
  assert.deepEqual(trades.map((t) => [t.side, t.outcome, t.price, t.size, t.timestamp]), [['BUY', 'Up', 0.58, 200, 5], ['BUY', 'Down', 0.42, 200, 5], ['SELL', 'Up', 0.6, 50, 65]]);
  assert.equal(trades[0].conditionId, `0x${RID}`);
  assert.equal(trades[1].asset, tokenIdOf(RID, NO));
  assert.equal(trades[0].transactionHash, `0x${'b1'.repeat(32)}`);
  const ct = clobTradeOf(trades[0]);
  assert.deepEqual([ct.market, ct.asset_id, ct.side, ct.price, ct.size, ct.status], [`0x${RID}`, tokenIdOf(RID, YES), 'BUY', '0.58', '200', 'CONFIRMED']);
  const up = historyOf({ batches, cutoffMs, outcome: YES, nowMs: 100000 });
  assert.deepEqual(up.history, [{ t: 5, p: 0.58 }, { t: 65, p: 0.6 }]);
  const down = historyOf({ batches, cutoffMs, outcome: NO, nowMs: 100000 });
  assert.deepEqual(down.history, [{ t: 5, p: 0.42 }, { t: 65, p: 0.4 }]);
  // a span and a fidelity: the last hour only (nothing that old is left out here), one point per 2 minutes
  assert.deepEqual(historyOf({ batches, cutoffMs, outcome: YES, interval: '1h', fidelity: 2, nowMs: 100000 }).history, [{ t: 0, p: 0.6 }]);
  assert.deepEqual(historyOf({ batches, cutoffMs, outcome: YES, startTs: 10, endTs: 100, nowMs: 100000 }).history, [{ t: 65, p: 0.6 }]);
  assert.equal(END_CURSOR, 'LTE=');
});

test('a py-clob-client order body reads as an Arena order: token -> round and side, amounts (6 decimals) -> price to the cent and whole shares; refusals by name', () => {
  // what ClobClient.create_order(OrderArgs(token_id, price=0.55, size=200, side=BUY)) posts: makerAmount 110 USDC, takerAmount 200 shares
  const body = { order: { salt: '123', maker: '0xabc', signer: '0xabc', taker: '0x0000000000000000000000000000000000000000', tokenId: tokenIdOf(RID, YES),
    makerAmount: '110000000', takerAmount: '200000000', expiration: '0', nonce: '0', feeRateBps: '0', side: 'BUY', signatureType: 0, signature: '0x00' }, owner: 'key', orderType: 'GTC' };
  const o = parseOrder(body);
  assert.equal(o.ok, true, o.why);
  assert.deepEqual([o.outcome, o.side, o.price, o.priceDecimal, o.shares, o.sharesMsat, o.netMsat, o.expiryMs, o.orderType], [YES, 'BUY', 55000n, '0.55', 200n, 200000n, 110000n, 0n, 'GTC']);
  assert.ok(o.candidates.includes(RID));
  // the stake that leaves that budget after the market's 1 % fee out of the stake
  assert.equal(stakeForNet(o.netMsat, 100), 111112n);
  assert.equal(stakeForNet(111112n, 100) - (111112n * 100n) / 10000n >= 110000n, true);
  // a SELL: maker gives shares, taker gives collateral; a GTD expiry in seconds; side as the signed order carries it (0 / 1)
  const sell = parseOrder({ order: { ...body.order, side: 1, makerAmount: '50000000', takerAmount: '35000000', expiration: '1791599000' }, orderType: 'GTD' });
  assert.deepEqual([sell.ok, sell.side, sell.priceDecimal, sell.shares, sell.expiryMs], [true, 'SELL', '0.7', 50n, 1791599000000n]);
  assert.equal(parseOrder({ order: { ...body.order, side: 0 } }).side, 'BUY');
  // refusals
  assert.match(parseOrder({}).why, /an order is \{ order/);
  assert.match(parseOrder({ order: { ...body.order, tokenId: '12ab' } }).why, /not a Bitcoin Arena token/);
  assert.match(parseOrder({ order: { ...body.order, side: 'HOLD' } }).why, /side is BUY/);
  assert.match(parseOrder({ order: { ...body.order, makerAmount: '200000000', takerAmount: '200000000' } }).why, /a price is 0.01 to 0.99/);
  assert.match(parseOrder({ order: { ...body.order, makerAmount: '1100000', takerAmount: '2000000' } }).why, /at least 5 shares/);
  assert.match(parseOrder({ ...body, orderType: 'IOC' }).why, /orderType is GTC/);
  console.log(`  ORDER: ${o.side} ${o.shares} ${['Up', 'Down'][o.outcome]} @ ${o.priceDecimal} = ${o.netMsat} msat budget, stake ${stakeForNet(o.netMsat, 100)} msat`);
});

test('an order as the CLOB lists it: id 0x + entry, BUY, size from the budget at the limit, matched shares, its status', () => {
  const entry = { pick: YES, limitPrice: 55000, stakeMsat: 111112n, feeMsat: 1112n, donationMsat: 0n, orderExpiryMs: 0n, playerPubkey: b32(9) };
  const eh = 'e1'.repeat(32);
  const live = orderJson({ roundHex: RID, entryHex: eh, entry, position: { shares: [0n, 0n], cancelled: false }, resting: true, batch: 3, receivedMs: 1791598000500, closed: false, outcomes: ['Up', 'Down'] });
  assert.deepEqual([live.id, live.status, live.side, live.original_size, live.size_matched, live.price, live.outcome, live.asset_id, live.market, live.order_type, live.created_at],
    [`0x${eh}`, 'LIVE', 'BUY', '200', '0', '0.55', 'Up', tokenIdOf(RID, YES), `0x${RID}`, 'GTC', 1791598000]);
  assert.equal(live.maker_address, `0x${toHex(b32(9))}`);
  const matched = orderJson({ roundHex: RID, entryHex: eh, entry, position: { shares: [200000n, 0n], cancelled: false }, resting: false, batch: 3, receivedMs: 0, closed: false, outcomes: ['Up', 'Down'] });
  assert.deepEqual([matched.status, matched.size_matched], ['MATCHED', '200']);
  assert.equal(orderJson({ roundHex: RID, entryHex: eh, entry, position: { shares: [0n, 0n], cancelled: true }, resting: false, batch: 3, receivedMs: 0, closed: false, outcomes: ['Up', 'Down'] }).status, 'CANCELED');
  assert.equal(orderJson({ roundHex: RID, entryHex: eh, entry, position: null, resting: false, batch: null, receivedMs: 0, closed: false, outcomes: ['Up', 'Down'] }).status, 'DELAYED');
  assert.equal(orderJson({ roundHex: RID, entryHex: eh, entry, position: { shares: [0n, 0n], cancelled: false }, resting: false, batch: 3, receivedMs: 0, closed: true, outcomes: ['Up', 'Down'] }).status, 'UNMATCHED');
});
