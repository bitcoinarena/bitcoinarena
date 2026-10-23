// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS AGREE EACH BATCH'S SET IN TIME FOR 0.5 S (re-measured with the certificate of comment 1127).
// Seven seats of one Up/Down market round; every order an entry whose stake and fee locks the seats verified; each batch led
// by the round's seat k mod 7 at its cutoff - the proposals, the set signed by every seat, and its certificate handed to every
// seat - with every seat-to-seat request delayed by a round trip MEASURED to a live seat through its Cloudflare tunnel
// (test host -> rps-a.bitcoin-arena.io, 40 warm requests on one connection, 2026-10-09: p50 56, p95 67, max 106 ms).
// A batch must be certified at every seat before the next cutoff: the time from a cutoff until then decides the interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { BATCH_MS, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
export const RTT_MS = [56, 54, 57, 53, 55, 58, 52, 56, 60, 54, 55, 57, 53, 56, 59, 61, 55, 54, 66, 57, 53, 56, 58, 55, 67, 54, 52, 57, 56, 106, 55, 54, 58, 56, 62, 53, 57, 55, 54, 60];
const RUNS = 10;
const player = (n) => ({ ...LOSER, name: `b${n}`, key: b32(0x20 + (n % 200)), worldSecret: b32(0) });
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

test('seven seats certify every batch of locked orders inside the interval: the time from a cutoff until all hold the certificate, at 0.5 s and 1 s', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  let turn = 0;
  for (const d of w.nodes) d.orderBook.fetcher = async (u, o) => { await wait(RTT_MS[turn++ % RTT_MS.length]); return fetch(u, o); };
  try {
    assert.equal(BATCH_MS, 500n);
    const results = {};
    let n = 0;
    for (const B of [500, 1000]) {
      for (const d of w.nodes) d.orderBook.intervalMs = B;
      const times = [];
      for (let run = 0; run < RUNS; run++) {
        // TWO ORDERS THAT CROSS, each locked and verified at every seat
        await lockAndPlay(w, player(n++), { noMarks: true, pick: YES, order: { price: BigInt(50 + (run % 5)) * 1000n } });
        await lockAndPlay(w, player(n++), { noMarks: true, pick: NO, order: { price: BigInt(55 - (run % 5)) * 1000n } });
        const k = Math.floor(testNow() / B);
        while (testNow() < (k + 1) * B) await wait(5);
        const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
        const got = await leader.orderBook.lead(w.rid, k);
        assert.equal(got.ok, true, got.why);
        assert.equal(got.certified, true, `batch ${k} was not certified: ${JSON.stringify(got.refused)}`);
        assert.equal(got.heldBy, 7);
        times.push(got.timings.certifiedMs);
      }
      results[B] = { runs: times.length, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)) };
    }
    // EVERY SEAT HOLDS THE SAME CERTIFIED BOOK
    const books = await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/book?round=${toHex(w.rid)}`).then((r) => r.json())));
    for (const b of books) assert.equal(JSON.stringify(b.batches), JSON.stringify(books[0].batches), 'two seats hold the book differently');
    console.log('  CERTIFIED:', JSON.stringify({ results, batches: books[0].batches.length, priced: books[0].batches.filter((x) => x.price !== null).length }));
    assert.equal(books[0].batches.length, 2 * RUNS);
    // A CERTIFICATE HELD ALREADY (kanban #576): answered from what the seat holds, no signature checked again - and another
    // set for that batch is still refused
    const held = w.nodes[1].orderBook.certificates(w.rid)[0];
    assert.deepEqual(w.nodes[1].orderBook.certify(w.rid, { record: held.record, sigs: held.sigs.map((s) => ({ ...s, signature: '00'.repeat(64) })) }), { ok: true, fresh: false });
    const other = w.nodes[1].orderBook.certify(w.rid, { record: { ...held.record, orders: held.record.orders.slice(1) }, sigs: held.sigs });
    assert.equal(other.ok, false);
    // THE INTERVAL: certified at every seat, plus the seats' 100 ms grace after the cutoff, before the next cutoff
    assert.ok(results[1000].max + 100 < 1000, `1 s does not hold: max ${results[1000].max} ms`);
    console.log(`  INTERVAL: ${results[500].max + 100 < 500 ? '0.5 s HOLDS' : '0.5 s does NOT hold'} (certified max ${results[500].max} ms + 100 ms grace)`);
  } finally { await w.close(); }
});
