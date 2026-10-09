// THE SEATS TAKE MARKET ORDERS AND AGREE EACH BATCH'S SET (kanban #278 step 4; the owner 2026-10-09: "Order batches alle 1s,
// wenn möglich alle 0.5s"). Seven seats of one Up/Down market round: orders posted to some seats only, each batch led by the
// round's seat k mod 7 at its cutoff, every seat holding and signing the same set, clearing it the same way - and the time
// from a cutoff until all seven hold the set, with every seat-to-seat request delayed by a round trip MEASURED to a live
// seat through its Cloudflare tunnel (test host -> rps-a.bitcoin-arena.io, 40 warm requests on one connection, 2026-10-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { orderId, orderToJson, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
// THE MARKET IS OPEN FOR THE WHOLE TEST: its entries (its orders) close at the round's start, 15 min out
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
// THE MEASURED ROUND TRIPS (ms): test host -> rps-a.bitcoin-arena.io (Cloudflare tunnel -> test host seat), warm, 2026-10-09
// 12:2xZ - p50 56, p95 67, max 106. Each seat-to-seat request below waits one of them, in turn.
const RTT_MS = [56, 54, 57, 53, 55, 58, 52, 56, 60, 54, 55, 57, 53, 56, 59, 61, 55, 54, 66, 57, 53, 56, 58, 55, 67, 54, 52, 57, 56, 106, 55, 54, 58, 56, 62, 53, 57, 55, 54, 60];
const SEATS = 7;

const players = Array.from({ length: 12 }, () => { const sk = ed25519.utils.randomSecretKey(); return { sk, pk: ed25519.getPublicKey(sk) }; });
let nonce = 0n;
function order(rid, who, outcome, cents, sat) {
  const o = { roundId: rid, playerKey: who.pk, outcome, price: BigInt(cents) * 1000n, stakeMsat: BigInt(sat) * 1000n, nonce: ++nonce, expiryMs: 0n };
  o.signature = ed25519.sign(orderId(o), who.sk);
  return Object.defineProperty(orderToJson(o), 'id', { value: toHex(orderId(o)), enumerable: false });
}
const postOrder = (d, json) => fetch(`http://127.0.0.1:${d.port}/order`, { method: 'POST', body: JSON.stringify(json) }).then(async (r) => [r.status, await r.json().catch(() => null)]);
const book = (d, rid) => fetch(`http://127.0.0.1:${d.port}/book?round=${toHex(rid)}`).then((r) => r.json());
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

test('seven seats take orders and agree every batch\'s set: the same set, signed by all, cleared the same; the time to agree at 0.5 s and 1 s with measured round trips', async () => {
  const w = await lockRound({ n: SEATS, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  // EVERY SEAT-TO-SEAT REQUEST OF THE BOOK WAITS ONE MEASURED ROUND TRIP (localhost itself is ~1 ms)
  let turn = 0;
  for (const d of w.nodes) d.orderBook.fetcher = async (u, o) => { await wait(RTT_MS[turn++ % RTT_MS.length]); return fetch(u, o); };
  try {
    // THE DOOR: a forged order, a price off the cent and too few shares are refused by name; a good one is taken once
    const good = order(w.rid, players[0], YES, 55, 10);
    const forged = { ...order(w.rid, players[1], NO, 45, 10), playerKey: toHex(players[2].pk) };
    const door = { good: (await postOrder(w.nodes[0], good))[0], again: (await postOrder(w.nodes[0], good))[0] };
    const refusals = await Promise.all([forged, { ...good, price: '55500' }, order(w.rid, players[3], YES, 90, 4)].map(async (j) => {
      const r = await fetch(`http://127.0.0.1:${w.nodes[0].port}/order`, { method: 'POST', body: JSON.stringify(j) }); return `${r.status} ${(await r.text()).trim()}`;
    }));
    console.log('  DOOR:', JSON.stringify({ door, refusals }));
    assert.deepEqual(door, { good: 201, again: 200 });
    assert.match(refusals[0], /^409 that order's signature is not its player's/);
    assert.match(refusals[1], /^409 a price is a whole tick of 1000/);
    assert.match(refusals[2], /^409 an order buys at least 5 shares at its limit/);

    const results = {};
    for (const B of [500, 1000]) {
      for (const d of w.nodes) d.orderBook.intervalMs = B;
      const times = [];
      let lastK = null;
      for (let run = 0; run < 20; run++) {
        // ORDERS OF THIS BATCH: six, each posted to only some seats (the leader's union must find them all)
        const now = testNow();
        const k = Math.floor(now / B);
        const orders = [order(w.rid, players[run % 12], YES, 50 + (run % 9), 10), order(w.rid, players[(run + 1) % 12], NO, 46 + (run % 7), 10),
          order(w.rid, players[(run + 2) % 12], YES, 60, 20), order(w.rid, players[(run + 3) % 12], NO, 40, 20),
          order(w.rid, players[(run + 4) % 12], YES, 52, 8), order(w.rid, players[(run + 5) % 12], NO, 49, 8)];
        await Promise.all(orders.map((j, i) => Promise.all(w.nodes.filter((_, s) => (s + i + run) % 3 === 0).map((d) => postOrder(d, j)))));
        // THE CUTOFF: (k + 1) x B on the seats' clock; the leader starts there
        const cutoff = (k + 1) * B;
        while (testNow() < cutoff) await wait(5);
        const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
        const t0 = performance.now();
        const got = await leader.orderBook.lead(w.rid, k);
        const ms = performance.now() - t0;
        assert.equal(got.ok, true, got.why);
        assert.equal(got.heldBy, SEATS, `batch ${k} held by ${got.heldBy} of ${SEATS}: ${JSON.stringify(got.refused)}`);
        for (const j of orders) assert.ok(got.orderIds.includes(j.id), 'an order posted to some seats only is not in the batch');
        times.push(ms);
        lastK = k;
      }
      results[B] = { runs: times.length, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)), lastK };
    }
    // EVERY SEAT HOLDS THE SAME BATCHES AND CLEARS THEM THE SAME (bookBatch over the same sets)
    const books = await Promise.all(w.nodes.map((d) => book(d, w.rid)));
    const fingerprint = (b) => JSON.stringify(b.batches.map((x) => [x.k, x.batchId, x.price, x.fills.map((f) => [f.id, f.payoutMsat, f.costMsat])]));
    for (const b of books) assert.equal(fingerprint(b), fingerprint(books[0]), 'two seats hold or clear the book differently');
    // A SECOND, DIFFERENT SET FOR A BATCH A SEAT ALREADY SIGNED IS REFUSED
    const other = { k: String(results[1000].lastK), orders: [order(w.rid, players[11], YES, 51, 10)], leader: toHex(w.nodes.find((d) => d.orderBook.leads(w.rid, results[1000].lastK)).round.pubkey), leaderSig: '00'.repeat(64) };
    const second = await fetch(`http://127.0.0.1:${w.nodes[1].port}/batch?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify(other) }).then(async (r) => `${r.status} ${(await r.text()).trim()}`);
    const priced = books[0].batches.filter((x) => x.price !== null);
    console.log('  AGREED:', JSON.stringify({ results, batches: books[0].batches.length, priced: priced.length, prices: priced.slice(0, 6).map((x) => x.price),
      standing: books[0].resting.length, second }));
    assert.match(second, /^(403 that batch is not signed by its leader|409 this seat already signed another set for batch)/);
    assert.equal(books[0].batches.length, 40, 'not one batch per run (the door\'s order rides in the first)');
    // THE INTERVAL: a batch must be agreed by every seat before the next cutoff
    assert.ok(results[1000].p95 < 1000, `1 s does not hold: p95 ${results[1000].p95} ms`);
    console.log(`  INTERVAL: ${results[500].max < 500 ? '0.5 s HOLDS' : '0.5 s does NOT hold'} (agreed p95 ${results[500].p95} ms, max ${results[500].max} ms with the measured round trips)`);
  } finally { await w.close(); }
});
