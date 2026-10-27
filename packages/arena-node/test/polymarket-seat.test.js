// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE POLYMARKET-COMPATIBLE DOORS ON A SEAT (kanban #736): an Up/Down window round on two signer nodes, two locked orders that cross,
// one certified batch - then every read a stock CLOB client makes (py-clob-client 0.34.6's paths and parameters, read from its source:
// endpoints.py, client.py) against /polymarket/ on the seat, and the writes answered 501 by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { tokenIdOf } from '../src/polymarket.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x90 + n), worldSecret: b32(0) });
const B = 500;

test('a stock CLOB client\'s reads against /polymarket/ on a seat: markets, the book, prices, history, trades, orders and positions of a certified batch; writes 501 by name', async () => {
  const w = await lockRound({ n: 2, stakeMsat: 10_000n, round: ROUND, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = `http://127.0.0.1:${w.a.port}/polymarket`;
  const get = async (path) => { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() }; };
  const rid = toHex(w.rid), cond = `0x${rid}`, up = tokenIdOf(rid, YES), down = tokenIdOf(rid, NO);
  try {
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    // THE CLIENT'S FIRST CALLS
    assert.equal((await get('/')).body, 'OK');
    assert.equal((await get('/ok')).body, 'OK');
    assert.equal(typeof (await get('/time')).body, 'number');
    // THE MARKET BEFORE ANY ORDER: listed, open, its book empty, no price
    const listed = await get('/markets?next_cursor=MA==');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.next_cursor, 'LTE=');
    const m0 = listed.body.data.find((m) => m.condition_id === cond);
    assert.ok(m0, 'the round is listed as a market');
    assert.deepEqual([m0.accepting_orders, m0.closed, m0.tokens.map((t) => t.outcome), m0.tokens.map((t) => t.token_id)], [true, false, ['Up', 'Down'], [up, down]]);
    assert.equal(m0.end_date_iso, new Date(Number(w.c.entryCloseMs)).toISOString());
    assert.equal((await get(`/markets/${cond}`)).body.condition_id, cond);
    assert.equal((await get(`/markets/0x${'00'.repeat(32)}`)).status, 404);
    const empty = await get(`/book?token_id=${up}`);
    assert.deepEqual([empty.body.bids, empty.body.asks, empty.body.last_trade_price, empty.body.market], [[], [], '', cond]);
    assert.deepEqual((await get(`/midpoint?token_id=${up}`)).body, { mid: '' });
    assert.equal((await get('/book?token_id=12345')).status, 404);
    // TWO ORDERS THAT CROSS, locked and verified at both seats: Up at 0.60, Down at 0.45 - resting until the batch
    const upOrder = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 60000n } });
    const downOrder = await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 45000n } });
    // AN ORDER TAKEN HERE BUT IN NO BATCH YET: DELAYED, listed with its id 0x + entry
    const delayed = await get(`/data/order/0x${toHex(upOrder.eid)}`);
    assert.deepEqual([delayed.status, delayed.body.status, delayed.body.side, delayed.body.price, delayed.body.asset_id, delayed.body.market], [200, 'DELAYED', 'BUY', '0.6', up, cond]);
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const led = await leader.orderBook.lead(w.rid, k);
    assert.equal(led.certified, true, led.why);
    // THE BOOK AFTER THE BATCH: the two crossed at one price (0.55 here); both budgets are ~9.9 sat, so the Down buy at 0.45 (22 shares) outlasts
    // the Up buy at 0.60 (16 shares) and its rest stays on the book - a Down bid at 0.45, which is an Up ask at 0.55
    const book = await get(`/book?token_id=${up}`);
    assert.equal(book.body.asset_id, up);
    assert.match(book.body.last_trade_price, /^0\.\d+$/);
    const downBook = await get(`/book?token_id=${down}`);
    const restingSide = book.body.asks.length ? 'asks' : book.body.bids.length ? 'bids' : 'none';
    assert.notEqual(restingSide, 'none', 'nothing rests after a batch of two unequal budgets');
    const q = { price: (await get(`/price?token_id=${up}&side=BUY`)).body, mid: (await get(`/midpoint?token_id=${up}`)).body, spread: (await get(`/spread?token_id=${up}`)).body,
      last: (await get(`/last-trade-price?token_id=${up}`)).body, tick: (await get(`/tick-size?token_id=${up}`)).body, neg: (await get(`/neg-risk?token_id=${up}`)).body, fee: (await get(`/fee-rate?token_id=${up}`)).body };
    assert.deepEqual([q.tick, q.neg, q.fee], [{ minimum_tick_size: '0.01' }, { neg_risk: false }, { fee_rate_bps: 100 }]);
    assert.match(q.last.price, /^0\.\d+$/);
    assert.equal(q.last.side, 'BUY');
    // THE HISTORY AND THE TRADES of the one certified batch
    const hist = await get(`/prices-history?market=${up}&interval=max&fidelity=1`);
    assert.equal(hist.body.history.length, 1);
    assert.equal(hist.body.history[0].p, Number(book.body.last_trade_price));
    const histDown = await get(`/prices-history?market=${down}&interval=1h`);
    assert.equal(Number((hist.body.history[0].p + histDown.body.history[0].p).toFixed(5)), 1);
    const trades = await get(`/trades?market=${cond}`);
    assert.equal(trades.body.length, 2, 'two fills, one per side');
    assert.deepEqual(trades.body.map((t) => t.side), ['BUY', 'BUY']);
    assert.deepEqual(new Set(trades.body.map((t) => t.outcome)), new Set(['Up', 'Down']));
    const clobTrades = await get(`/data/trades?market=${cond}`);
    assert.deepEqual([clobTrades.body.count, clobTrades.body.next_cursor, clobTrades.body.data[0].status], [2, 'LTE=', 'CONFIRMED']);
    assert.equal((await get(`/live-activity/events/${cond}`)).body.length, 2);
    // THE ORDERS: both in the batch; the one with budget left LIVE, the other MATCHED; the open listing holds the live one only
    const upNow = (await get(`/data/order/0x${toHex(upOrder.eid)}`)).body, downNow = (await get(`/data/order/0x${toHex(downOrder.eid)}`)).body;
    assert.deepEqual(new Set([upNow.status, downNow.status]), new Set(['LIVE', 'MATCHED']));
    assert.ok(Number(upNow.size_matched) > 0 && Number(downNow.size_matched) > 0, 'both filled');
    assert.equal(upNow.size_matched, downNow.size_matched, 'a complete set: the same shares each side');
    const open = await get(`/data/orders?market=${cond}`);
    assert.equal(open.body.data.length, 1);
    assert.equal(open.body.data[0].status, 'LIVE');
    const all = await get(`/data/orders?market=${cond}&all=1`);
    assert.equal(all.body.data.length, 2);
    const byMaker = await get(`/data/orders?market=${cond}&all=1&maker_address=${upNow.maker_address}`);
    assert.deepEqual(byMaker.body.data.map((o) => o.id), [upNow.id]);
    // POSITIONS of a player key: Up's holder holds Up shares, valued at the mid
    const pos = await get(`/positions?user=${upNow.maker_address}&market=${cond}`);
    assert.equal(pos.body.length, 1);
    assert.deepEqual([pos.body[0].outcome, pos.body[0].asset, pos.body[0].conditionId, String(pos.body[0].size)], ['Up', up, cond, upNow.size_matched]);
    assert.equal((await get(`/positions?user=0x${'11'.repeat(32)}`)).body.length, 0);
    // GAMMA: the event and its market carry the same ids
    const events = await get('/events?active=true');
    const ev = events.body.find((e) => e.id === cond);
    assert.deepEqual([ev.markets.length, JSON.parse(ev.markets[0].clobTokenIds)], [1, [up, down]]);
    // THE WRITES A SEAT CANNOT DO: 501, Polymarket's error shape, the adapter named
    const post = async (path, method = 'POST') => { const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };
    const placed = await post('/order');
    assert.deepEqual([placed.status, placed.body.success], [501, false]);
    assert.match(placed.body.errorMsg, /Arena CLOB adapter/);
    assert.equal((await post('/order', 'DELETE')).status, 501);
    assert.equal((await post('/auth/api-key')).status, 501);
    assert.equal((await get('/nothing')).status, 404);
    console.log(`  POLYMARKET: market ${m0.market_slug} | book Up bids ${JSON.stringify(book.body.bids)} asks ${JSON.stringify(book.body.asks)} | Down bids ${JSON.stringify(downBook.body.bids)} | price ${JSON.stringify(q.price)} mid ${JSON.stringify(q.mid)} spread ${JSON.stringify(q.spread)} last ${q.last.price} | trades ${trades.body.map((t) => `${t.outcome}@${t.price}x${t.size}`).join(' ')} | orders ${upNow.status}/${downNow.status} matched ${upNow.size_matched}`);
  } finally { await w.close(); }
});
