// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA CLOB ADAPTER BESIDE A BOT (kanban #736): a stock client's write path - L1 credentials minted, every write under its L2 HMAC
// as py-clob-client signs it (headers/headers.py, signing/hmac.py), POST /order read as an Arena order and placed (here by a stub that
// locks the order on the in-process seats as the fixture does), listed back from the seats as the adapter's own, cancelled by its session
// key and CANCELED on the seats after the next batch; the reads passed through to a seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { YES } from '../../arena-protocol/src/order-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { tokenIdOf, stakeForNet } from '../src/polymarket.js';
import { createAdapter, hmacSignature } from '../tools/polymarket-adapter.mjs';
import { cancelOrder } from '../tools/arena-order.mjs';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `a${n}`, key: b32(0xa0 + n), worldSecret: b32(0) });
const B = 500;
const ADDRESS = '0x' + 'ab'.repeat(20);

test('the adapter: credentials minted, an order placed under the client\'s HMAC and listed as its own, cancelled by its session key; reads relayed to a seat', async () => {
  const w = await lockRound({ n: 2, stakeMsat: 10_000n, round: ROUND, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
  const rid = toHex(w.rid), up = tokenIdOf(rid, YES);
  // THE PLACER: the fixture's lock-and-play on the test seats, in the adapter's shape (the real one is arena-order.mjs placeOrder with a wallet)
  const placed = [];
  const placer = async (o) => {
    placed.push(o);
    const e = await lockAndPlay(w, player(10 + o.orderIndex), { noMarks: true, pick: o.outcome, order: { price: o.price, expiryMs: o.expiryMs } });
    return { entry: toHex(e.eid), session: toHex(e.session), player: toHex(e.entry.playerPubkey), windowEndMs: Number(w.c.entryCloseMs) };
  };
  const a = createAdapter({ nodes, dir: mkdtempSync(join(tmpdir(), "pm-adapter-")), placer, canceller: (o) => cancelOrder({ nodes, ...o }), now: () => testNow() });
  const port = await a.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { body = null, headers = {} } = {}) => { const r = await fetch(`${base}${path}`, { method, headers, body }); return { status: r.status, body: await r.json() }; };
  const batch = async () => { const k = Math.floor(testNow() / B); while (testNow() < (k + 1) * B + 20) await wait(5); const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k)); const got = await leader.orderBook.lead(w.rid, k); assert.equal(got.ok, true, got.why); return got; };
  try {
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    // THE READS, RELAYED
    const markets = await call('GET', '/markets?next_cursor=MA==');
    assert.equal(markets.status, 200);
    assert.ok(markets.body.data.some((m) => m.condition_id === `0x${rid}`));
    assert.equal((await call('GET', `/book?token_id=${up}`)).body.asset_id, up);
    assert.equal((await call('GET', '/time')).status, 200);
    // L1: the credentials, minted once and derived again
    const l1 = { POLY_ADDRESS: ADDRESS, POLY_SIGNATURE: '0xsigned', POLY_TIMESTAMP: String(Math.floor(testNow() / 1000)), POLY_NONCE: '0' };
    assert.equal((await call('POST', '/auth/api-key')).status, 401);
    const creds = (await call('POST', '/auth/api-key', { headers: l1 })).body;
    assert.deepEqual(Object.keys(creds).sort(), ['apiKey', 'passphrase', 'secret']);
    assert.deepEqual((await call('GET', '/auth/derive-api-key', { headers: l1 })).body, creds);
    assert.deepEqual((await call('POST', '/auth/api-key', { headers: l1 })).body, creds);
    // L2: the headers as create_level_2_headers builds them, the body as post_order serializes it
    const l2 = (method, path, body = '') => { const ts = String(Math.floor(testNow() / 1000)); return { POLY_ADDRESS: ADDRESS, POLY_API_KEY: creds.apiKey, POLY_PASSPHRASE: creds.passphrase, POLY_TIMESTAMP: ts, POLY_SIGNATURE: hmacSignature(creds.secret, ts, method, path, body), 'content-type': 'application/json' }; };
    // what ClobClient.create_order(OrderArgs(up, price=0.55, size=20, side=BUY)) posts
    const order = JSON.stringify({ order: { salt: '42', maker: ADDRESS, signer: ADDRESS, taker: '0x0000000000000000000000000000000000000000', tokenId: up, makerAmount: '11000000', takerAmount: '20000000', expiration: '0', nonce: '0', feeRateBps: '0', side: 'BUY', signatureType: 0, signature: '0x00' }, owner: creds.apiKey, orderType: 'GTC', postOnly: false });
    const noAuth = await call('POST', '/order', { body: order, headers: { 'content-type': 'application/json' } });
    assert.deepEqual([noAuth.status, noAuth.body.success], [401, false]);
    const badSig = await call('POST', '/order', { body: order, headers: { ...l2('POST', '/order', order), POLY_SIGNATURE: 'nope' } });
    assert.equal(badSig.status, 401); assert.match(badSig.body.errorMsg, /HMAC/);
    const posted = await call('POST', '/order', { body: order, headers: l2('POST', '/order', order) });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.deepEqual([posted.body.success, posted.body.status, posted.body.orderID.length], [true, 'live', 66]);
    assert.equal(placed.length, 1);
    assert.deepEqual([placed[0].roundHex, placed[0].outcome, placed[0].price, placed[0].orderIndex, placed[0].expiryMs], [rid, YES, 55000n, 0, 0n]);
    assert.equal(placed[0].stakeMsat, stakeForNet(20n * 1000n * 55000n / 100000n, 100), 'the stake leaves the budget of 20 shares at 0.55 after the 1 % fee');
    // a bad body is named, not placed
    const bad = await call('POST', '/order', { body: '{"order":{}}', headers: l2('POST', '/order', '{"order":{}}') });
    assert.deepEqual([bad.status, bad.body.success], [400, false]);
    assert.equal(placed.length, 1);
    // THE ORDER AS THE ADAPTER'S OWN: from the seat, filtered to this key; DELAYED until a batch, LIVE after it
    const mine = await call('GET', '/data/orders', { headers: l2('GET', '/data/orders') });
    assert.deepEqual([mine.status, mine.body.data.length, mine.body.data[0].id, mine.body.data[0].status, mine.body.next_cursor], [200, 1, posted.body.orderID, 'DELAYED', 'LTE=']);
    await batch();
    const one = await call('GET', `/data/order/${posted.body.orderID}`, { headers: l2('GET', `/data/order/${posted.body.orderID}`) });
    // (18 shares, not 20: the stub locks the fixture's 10,000 msat whatever the stake asked - 9,900 net at 0.55; the real placer locks `stakeMsat`)
    assert.deepEqual([one.status, one.body.status, one.body.price, one.body.original_size], [200, 'LIVE', '0.55', '18']);
    assert.equal((await call('GET', `/data/order/0x${'22'.repeat(32)}`, { headers: l2('GET', `/data/order/0x${'22'.repeat(32)}`) })).status, 404);
    // THE CANCEL: the session key signs it, the seats take it, the next batch carries it
    const cancelBody = JSON.stringify({ orderID: posted.body.orderID });
    const cancelled = await call('DELETE', '/order', { body: cancelBody, headers: l2('DELETE', '/order', cancelBody) });
    assert.deepEqual([cancelled.status, cancelled.body.canceled, cancelled.body.not_canceled], [200, [posted.body.orderID], {}]);
    await batch();
    const after = await call('GET', `/data/order/${posted.body.orderID}`, { headers: l2('GET', `/data/order/${posted.body.orderID}`) });
    assert.equal(after.body.status, 'CANCELED');
    assert.equal((await call('GET', '/data/orders', { headers: l2('GET', '/data/orders') })).body.data.length, 0, 'no open order is left');
    const notMine = await call('DELETE', '/order', { body: JSON.stringify({ orderID: `0x${'33'.repeat(32)}` }), headers: l2('DELETE', '/order', JSON.stringify({ orderID: `0x${'33'.repeat(32)}` })) });
    assert.deepEqual(notMine.body.canceled, []);
    assert.equal(a.state.orders.length, 1);
    console.log(`  ADAPTER: creds ${creds.apiKey.slice(0, 8)}… order ${posted.body.orderID.slice(0, 18)}… stake ${placed[0].stakeMsat} msat -> ${one.body.status} -> ${after.body.status}`);
  } finally { await a.close(); await w.close(); }
});
