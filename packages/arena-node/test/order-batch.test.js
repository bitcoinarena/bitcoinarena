// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS AGREE EACH BATCH'S SET IN TIME FOR 0.5 S (re-measured with the certificate of comment 1127).
// Seven seats of one Up/Down market round; every order an entry whose stake and fee locks the seats verified; each batch led
// by the round's seat k mod 7 at its cutoff - the proposals, the set signed by every seat, and its certificate handed to every
// seat - with every seat-to-seat request delayed by a round trip MEASURED to a live seat through its Cloudflare tunnel
// (macOS -> rps-a.bitcoin-arena.io, 40 warm requests on one connection, 2026-10-09: p50 56, p95 67, max 106 ms).
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
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';

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
    // 1 s FIRST: a batch's number is its time slot, and a seat signs no batch below one it holds (kanban #1150) - at 0.5 s after 1 s
    // the numbers only rise
    for (const B of [1000, 500]) {
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
    // AND CARRY LOOKS AT NONE OF THEM AGAIN (kanban #576): every peer hands the same certified batches, all held here already
    { const ob = w.nodes[1].orderBook, orig = ob.certify.bind(ob); let calls = 0;
      ob.certify = (...a) => { calls += 1; return orig(...a); };
      await ob.carry(w.rid);
      ob.certify = orig;
      assert.equal(calls, 0, 'carry certified batches this seat holds already'); }
    // A SEAT THAT NEVER RECEIVED ONE ORDER OF A CERTIFIED BATCH (kanban #620, round 42835aaa: two seats lacked entry 008e278a, refused the
    // batch's certificate, and rebuilt another settlement than the rest): carry replays the order from the seat that hands the batch - its
    // entry by its hash, its stake and fee lock checked with the federation - takes the certificate, and the books are one again
    { const d = w.nodes[2], rid = Buffer.from(w.rid);
      const cert = d.orderBook.certificates(w.rid).find((c) => c.record.orders.length);
      const eid = cert.record.orders[0], e = Buffer.from(eid, 'hex');
      // and its handout (the stake's shares): fed2-3 had not received it either ("a loser's P could not be opened: this node accepted no
      // handout for that entry")
      const vss = decodeEntryContract(d.round.entry(e)).vssSharesRef;
      d.round.db.exec('PRAGMA foreign_keys = OFF');   // (the loss simulated: rows that never arrived)
      d.round.db.prepare('DELETE FROM handouts WHERE handout_id = ?').run(Buffer.from(vss));
      for (const [t, col, v] of [['entries', 'entry_id', e], ['stake_locks', 'entry_id', e], ['fee_locks', 'entry_id', e], ['stake_seen', 'entry_id', e], ['market_orders', 'order_id', eid]])
        d.round.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(v);
      d.round.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, Number(cert.record.k));
      d.round.db.exec('PRAGMA foreign_keys = ON');
      const refused = d.orderBook.certify(w.rid, cert);
      assert.equal(refused.ok, false); assert.match(refused.why, /holds no entry/);
      await d.orderBook.carry(w.rid);
      assert.ok(d.round.entry(e), 'the entry was replayed');
      assert.ok(d.round.stakeLock(e), 'its stake lock was verified and kept');
      assert.ok(d.round.handout(vss), 'its handout was checked and kept');
      // the batch held certified here, only the handout gone (fed2-3 at 16:51Z): carry replays it all the same
      d.round.db.prepare('DELETE FROM handouts WHERE handout_id = ?').run(Buffer.from(vss));
      await d.orderBook.carry(w.rid);
      assert.ok(d.round.handout(vss), 'the handout of an order in a batch held here was replayed');
      assert.ok(d.orderBook.certificates(w.rid).some((c) => String(c.record.k) === String(cert.record.k)), 'the batch is certified here again');
      const again = await Promise.all(w.nodes.map((x) => fetch(`http://127.0.0.1:${x.port}/book?round=${toHex(w.rid)}`).then((r) => r.json())));
      for (const b of again) assert.equal(JSON.stringify(b.batches), JSON.stringify(again[0].batches), 'two seats hold the book differently after the replay'); }
    // A CLOSED MARKET ASKS NOBODY (kanban #576): a batch after the close, with nothing pending here, sends no request at all
    const kc = Math.floor(Number(w.c.entryCloseMs) / w.nodes[0].orderBook.intervalMs) + 5;
    const lc = w.nodes.find((d) => d.orderBook.leads(w.rid, kc));
    const was = lc.orderBook.fetcher; let asked = 0;
    lc.orderBook.fetcher = async (u, o) => { asked += 1; return was(u, o); };
    assert.deepEqual(await lc.orderBook.lead(w.rid, kc), { ok: true, empty: true, decided: [] });
    assert.equal(asked, 0, 'a closed market\'s leader asked its peers');
    lc.orderBook.fetcher = was;
    // THE INTERVAL: certified at every seat, plus the seats' 100 ms grace after the cutoff, before the next cutoff
    assert.ok(results[1000].max + 100 < 1000, `1 s does not hold: max ${results[1000].max} ms`);
    console.log(`  INTERVAL: ${results[500].max + 100 < 500 ? '0.5 s HOLDS' : '0.5 s does NOT hold'} (certified max ${results[500].max} ms + 100 ms grace)`);
  } finally { await w.close(); }
});
