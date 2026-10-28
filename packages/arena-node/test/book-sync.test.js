// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT THAT MISSED A BATCH CERTIFICATE HOLDS ANOTHER BOOK (kanban #740, measured 2026-10-28 00:2xZ, Up/Down round 5d4cbd41, 7 seats,
// threshold 5): five seats held batch 3586289144 (one Up order) and 3586289193 (one Down order), 193 filled; two overloaded seats never
// received 144's record or certificate, cleared 193 alone - price null, no fill - and answered the settlement "no lock is claimed: no
// order filled", so only 3 of the 5 signer nodes needed committed and nothing settled. Reproduced here on seven seats: the same two
// batches, two seats left out of the first. Before a seat plans a book's settlement it reads the other seats' certified batches
// (order-batch.js sync) and takes what it lacks through certify; while fewer than the threshold of seats answered it says "not yet",
// never "no order filled"; a certificate with too few signatures is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS, UPDOWN_ATTESTOR_KEYS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { attestWindow, combine } from '../../arena-attestor/src/attestor.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const ATTESTORS = UPDOWN.attestors.map((a) => toHex(a.pubkey));
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x90 + n), worldSecret: b32(0) });
const B = 500;

test('a seat that missed a batch certificate reads the other seats\' batches before it settles: it takes the missing one and agrees on the fill; with no peer heard it says "not yet", never "no order filled"; a short certificate is refused', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
    endMs: testNow() + 1800000, serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  const rid = toHex(w.rid);
  const book = async (d) => (await fetch(`${base(d)}/book?round=${rid}`)).json();
  const nextK = async () => { const k = Math.floor(testNow() / B); while (testNow() < (k + 1) * B + 20) await wait(5); return k; };
  const facts = {};
  try {
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    // 1. BATCH A: ONE UP ORDER, certified by five seats - the two others never receive its record or its certificate
    const up = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 60000n } });
    const kA = await nextK();
    const leadA = w.nodes.find((d) => d.orderBook.leads(w.rid, kA));
    const lagging = w.nodes.filter((d) => d !== leadA).slice(-2);
    const healthy = w.nodes.filter((d) => !lagging.includes(d));
    const peersA = leadA.orderBook.peersFor;
    leadA.orderBook.peersFor = (r) => peersA(r).filter((b) => !lagging.some((d) => b === base(d)));
    const a = await leadA.orderBook.lead(w.rid, kA);
    leadA.orderBook.peersFor = peersA;
    assert.equal(a.ok, true, a.why);
    assert.deepEqual([a.certified, a.heldBy, a.orderIds.length], [true, 5, 1]);
    // THE CURSOR (kanban #740 ruling, 2026-10-28: the seats ran out of memory): a seat's first read of the round asks every seat for the
    // whole list; it then holds batch A from the five, so its next read asks those only for the batches after A
    const reader = healthy[0], asks = [];
    const spy = (ob) => {
      const was = ob.fetcher;
      ob.fetcher = async (u, opt) => {
        const r = await was(u, opt);
        if (/\/book-certificates/.test(u)) asks.push({ u, ks: (await r.clone().json()).certificates.map((c) => String(c.record.k)) });
        return r;
      };
      return () => { ob.fetcher = was; };
    };
    // a read ends once a threshold answered; the other seats' answers are still taken after it
    const allSix = async () => { for (const stop = Date.now() + 5000; asks.length < 6 && Date.now() < stop;) await wait(10); await wait(50); };
    { const unspy = spy(reader.orderBook);
      assert.equal((await reader.orderBook.sync(w.rid, { force: true })).ok, true);
      await allSix();
      unspy();
      assert.equal(asks.length, 6);
      for (const x of asks) assert.doesNotMatch(x.u, /after=/, 'a first read asked with a cursor'); }
    // 2. BATCH B: ONE DOWN ORDER, at all seven - it crosses the Up order resting at the five
    const down = await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 45000n } });
    const kB = await nextK();
    const b = await w.nodes.find((d) => d.orderBook.leads(w.rid, kB)).orderBook.lead(w.rid, kB);
    assert.equal(b.ok, true, b.why);
    assert.deepEqual([b.certified, b.heldBy, b.orderIds], [true, 7, [toHex(down.eid)]]);
    // THE NEXT READ: the four other healthy seats are asked after=A and hand batch B only; the two lagging ones, which listed nothing to
    // that seat before, are asked for the whole list - it is B alone there too
    { asks.length = 0;
      const unspy = spy(reader.orderBook);
      assert.equal((await reader.orderBook.sync(w.rid, { force: true })).ok, true);
      await allSix();
      unspy();
      assert.equal(asks.length, 6);
      for (const x of asks) {
        const d = w.nodes.find((n) => x.u.startsWith(`${base(n)}/`));
        if (lagging.includes(d)) assert.doesNotMatch(x.u, /after=/, 'a seat that listed nothing was asked with a cursor');
        else assert.match(x.u, new RegExp(`&after=${kA}$`));
        assert.deepEqual(x.ks, [String(kB)]);
      }
      facts.cursor = asks.map((x) => (x.u.match(/after=(\d+)/) || [null, 'all'])[1]).sort().join(','); }
    // THE MEASURED SPLIT: the five fill batch B, the two clear it alone - price null, no fill
    const seen = await Promise.all(w.nodes.map(book));
    const shape = (x) => x.batches.map((y) => `${y.k}:${y.price}:${(y.fills || []).length}`).join(' ');
    facts.before = { healthy: shape(seen[w.nodes.indexOf(healthy[0])]), lagging: shape(seen[w.nodes.indexOf(lagging[0])]) };
    for (const d of healthy) assert.equal(shape(seen[w.nodes.indexOf(d)]), facts.before.healthy);
    for (const d of lagging) assert.equal(shape(seen[w.nodes.indexOf(d)]), facts.before.lagging);
    assert.equal(seen[w.nodes.indexOf(lagging[0])].batches.length, 1);
    assert.equal(seen[w.nodes.indexOf(lagging[0])].batches[0].price, null);
    assert.equal(seen[w.nodes.indexOf(healthy[0])].batches.length, 2);
    assert.notEqual(seen[w.nodes.indexOf(healthy[0])].batches[1].price, null);
    // 3. A FORGED CERTIFICATE - batch A's with four of its five signatures - is refused at the door and in the read
    const certA = healthy[0].orderBook.certificates(w.rid).find((c) => String(c.record.k) === String(kA));
    const short = { record: certA.record, sigs: certA.sigs.slice(0, 4) };
    const door = await fetch(`${base(lagging[0])}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify(short) });
    facts.forged = `${door.status} ${(await door.text()).trim()}`;
    assert.match(facts.forged, /^403 that certificate carries 4 seats' signatures and batch \d+ needs 5/);
    { const ob = lagging[0].orderBook, was = ob.fetcher;
      ob.fetcher = async (u) => (/\/book-certificates/.test(u) ? new Response(JSON.stringify({ certificates: [short] }), { status: 200 }) : was(u));
      await ob.carry(w.rid);
      ob.fetcher = was;
      assert.equal((await book(lagging[0])).batches.length, 1, 'a certificate with four signatures was taken'); }
    // 4. THE OUTCOME: Up, final
    skipTo(Number(w.c.entryCloseMs) + 2 * B + 10);
    await closeRound(w, { window: false });
    const startMs = w.c.entryCloseMs - UPDOWN_PERIOD_MS;
    const samples = [{ atMs: startMs - 60000n, price: 8295000n }, { atMs: startMs + 60000n, price: 8299000n }];
    const att = combine(['A', 'B'].map((l) => attestWindow({ samples, roundId: w.rid, window: { startMs, endMs: w.c.entryCloseMs }, attestor: UPDOWN_ATTESTOR_KEYS[l] })), { attestors: ATTESTORS, threshold: 2 });
    await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/outcome?round=${rid}`, { method: 'POST', body: att.bytes })));
    const o = await (await fetch(`${base(w.a)}/outcome?round=${rid}`)).json();
    skipTo(Number(o.finalAtMs) + 100);
    // 5. A LAGGING SEAT THAT HEARS NO OTHER SEAT says "not yet" - before the fix it answered "no order filled", and the combiner
    // counted it out
    { const ob = lagging[0].orderBook, was = ob.fetcher;
      ob.fetcher = async (u) => { if (/\/book-certificates/.test(u)) throw new Error('unreachable'); return was(u); };
      const got = await lagging[0].settlements.planOf(w.rid);
      ob.fetcher = was;
      facts.unheard = got.why;
      assert.equal(got.ok, false);
      assert.doesNotMatch(String(got.why), /no order filled/, 'a seat that heard no other seat said no order filled');
      assert.match(String(got.why), /^not yet: reading the other seats' batches - 1 of the 5 seats' certified batches heard here/); }
    // AND A PEER THAT NEVER ANSWERS is waited for no longer than the read's timeout
    { const ob = lagging[0].orderBook, was = ob.fetcher, t = ob.syncTimeoutMs;
      ob.syncTimeoutMs = 300;
      ob.fetcher = async (u, opt) => (/\/book-certificates/.test(u) ? new Promise(() => {}) : was(u, opt));
      const t0 = Date.now();
      const got = await lagging[0].settlements.planOf(w.rid);
      facts.hungMs = Date.now() - t0;
      ob.fetcher = was; ob.syncTimeoutMs = t;
      assert.match(String(got.why), /^not yet: .*no answer in 300 ms/);
      assert.ok(facts.hungMs < 3000, `the read waited ${facts.hungMs} ms`); }
    // A READ KEPT FOR THE ROUND THAT STILL MISSES THE BATCH (every peer listed nothing): the seat refuses as before - and once an asker
    // names the bytes the others built, it reads again, takes batch A, and commits to those bytes
    { const d = lagging[1], ob = d.orderBook, was = ob.fetcher;
      ob.fetcher = async (u, opt) => (/\/book-certificates/.test(u) ? new Response(JSON.stringify({ certificates: [] }), { status: 200 }) : was(u, opt));
      assert.equal((await ob.sync(w.rid, { force: true })).ok, true);
      ob.fetcher = was;
      const short = await d.settlements.planOf(w.rid);
      assert.match(String(short.why), /no order filled/);
      const asker = await healthy[0].settlements.message(w.rid);
      assert.equal(asker.ok, true, asker.why);
      const c = await d.settlements.commit(w.rid, { txid: asker.txid });
      facts.resync = c.ok ? 'committed' : c.why;
      assert.equal(c.ok, true, c.why);
      assert.equal((await book(d)).batches.length, 2, 'the batch was not taken on the mismatch'); }
    // 6. WITH ITS PEERS HEARD: batch A taken through certify, the same book as the five, and one settlement built by all seven. The
    // lagging seat holds batch B and not A: its cursor is never its highest batch held - it was taken from no seat's list yet, so
    // every seat is asked for the whole list and A comes with it
    asks.length = 0;
    const unspyLag = spy(lagging[0].orderBook);
    const plans = await Promise.all(w.nodes.map((d) => d.settlements.message(w.rid)));
    await allSix();
    unspyLag();
    assert.equal(asks.length, 6);
    for (const x of asks) assert.doesNotMatch(x.u, /after=/, `the lagging seat asked with a cursor: ${x.u}`);
    for (const p of plans) assert.equal(p.ok, true, p.why);
    facts.txids = [...new Set(plans.map((p) => p.txid))].length;
    assert.equal(facts.txids, 1, 'the seats built different settlements');
    const after = await Promise.all(w.nodes.map(book));
    for (const x of after) assert.equal(shape(x), facts.before.healthy, 'a seat holds the book otherwise after the read');
    facts.after = shape(after[w.nodes.indexOf(lagging[0])]);
    // THE DOOR: without `after` the whole list as before, with it only the later batches, a malformed cursor refused
    { const list = async (q) => { const r = await fetch(`${base(healthy[1])}/book-certificates?round=${rid}${q}`); return r.ok ? (await r.json()) : r.status; };
      const all = await list('');
      assert.deepEqual(all.certificates.map((c) => String(c.record.k)), [String(kA), String(kB)]);
      assert.deepEqual(all.pending, []);
      assert.deepEqual((await list(`&after=${kA}`)).certificates.map((c) => String(c.record.k)), [String(kB)]);
      assert.deepEqual((await list(`&after=${kB}`)).certificates, []);
      assert.deepEqual((await list(`&after=${kA - 1}`)).certificates, all.certificates);
      assert.equal(await list('&after=x'), 400); }
    // ONE READ PER ROUND: the next plan asks no seat again
    { const ob = lagging[1].orderBook, was = ob.fetcher; let asked = 0;
      ob.fetcher = async (u, opt) => { if (/\/book-certificates/.test(u)) asked += 1; return was(u, opt); };
      const again = await lagging[1].settlements.planOf(w.rid);
      ob.fetcher = was;
      assert.equal(again.ok, true, again.why);
      assert.equal(asked, 0, 'a second plan read the other seats again'); }
    // 7. AND IT SETTLES
    let got;
    for (const stop = Date.now() + 90000, nudged = { at: 0 }; Date.now() < stop; await wait(250)) {
      got = await standing(w.a, w);
      if (got.state === 'ACCEPTED') break;
      if (Date.now() - nudged.at > 1000) { nudged.at = Date.now(); await Promise.all(w.nodes.map((d) => d.settlements.settle(w.rid).catch(() => null))); }
    }
    facts.settled = got.state;
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(((got.moved && got.moved.claims) || []).length, 4, 'not the two locks of each filled order');
    console.log('  BOOK-SYNC:', JSON.stringify({ ...facts, up: toHex(up.eid).slice(0, 16) }));
  } finally { await w.close(); }
});
