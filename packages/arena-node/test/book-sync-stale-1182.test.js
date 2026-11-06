// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1182: A KEPT READ OF THE OTHER SEATS' BATCHES GOES STALE WHEN THE BOOK MOVES. A seat keeps its read of a round's certified batches
// once it was complete, and asked nobody again; a certificate that reached it later (a lower k another seat certified late) left the read
// kept, so a batch it still missed was never read, and it settled from a book the others had moved on from. Now a certificate stored
// outside the read makes the read STALE (order-batch.js SYNC_STATE), and the next read asks every seat for the whole list again.
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

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x90 + n), worldSecret: b32(0) });
const B = 500;

test('#1182: a certificate that reaches a seat after its kept read makes the read stale: the next read asks again and takes the batch it still missed', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
    endMs: testNow() + 1800000, serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  const rid = toHex(w.rid);
  const nextK = async () => { const k = Math.floor(testNow() / B); while (testNow() < (k + 1) * B + 20) await wait(5); return k; };
  const without = async (d, k, left) => { const ob = d.orderBook, was = ob.peersFor; ob.peersFor = (r) => was(r).filter((b) => !left.some((x) => b === base(x))); try { return await ob.lead(w.rid, k); } finally { ob.peersFor = was; } };
  try {
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    // 1. BATCH A at all seven; the reader's read of the other seats is complete and kept
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 60000n } });
    const kA = await nextK();
    const a = await w.nodes.find((d) => d.orderBook.leads(w.rid, kA)).orderBook.lead(w.rid, kA);
    assert.deepEqual([a.ok, a.certified], [true, true], a.why);
    const reader = w.nodes.find((d) => !d.orderBook.leads(w.rid, kA));
    // the next batch the reader does not lead (it is left out of it)
    const notReaders = async () => { for (;;) { const k = await nextK(); if (!reader.orderBook.leads(w.rid, k)) return k; } };
    assert.equal((await reader.orderBook.sync(w.rid, { force: true })).ok, true);
    assert.equal((await reader.orderBook.sync(w.rid)).kept, true, 'the read is kept');
    // 2. BATCH X (lower k) and BATCH Y certified by the six others: the reader never receives either
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 45000n } });
    const kX = await notReaders();
    const x = await without(w.nodes.find((d) => d.orderBook.leads(w.rid, kX)), kX, [reader]);
    assert.deepEqual([x.ok, x.certified, x.heldBy], [true, true, 6], x.why);
    await lockAndPlay(w, player(3), { noMarks: true, pick: YES, order: { price: 50000n } });
    const kY = await notReaders();
    const yLead = w.nodes.find((d) => d.orderBook.leads(w.rid, kY));
    const y = await without(yLead, kY, [reader]);
    assert.deepEqual([y.ok, y.certified], [true, true], y.why);
    // 3. Y's certificate reaches the reader late, at its door
    const certY = yLead.orderBook.certificates(w.rid).find((c) => String(c.record.k) === String(kY));
    const door = await fetch(`${base(reader)}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify(certY) });
    assert.ok(door.ok, await door.clone().text());
    const held = () => reader.orderBook.certificates(w.rid).map((c) => String(c.record.k));
    assert.equal(held().includes(String(kX)), false, 'the reader misses batch X');
    // 4. THE NEXT READ before a settlement
    let asked = 0;
    const was = reader.orderBook.fetcher;
    reader.orderBook.fetcher = async (u, opt) => { if (/\/book-certificates/.test(u)) asked += 1; return was(u, opt); };
    const again = await reader.orderBook.sync(w.rid);
    for (const stop = Date.now() + 5000; asked < 6 && Date.now() < stop;) await wait(10);
    await wait(100);
    reader.orderBook.fetcher = was;
    const state = typeof reader.orderBook.syncState === 'function' ? reader.orderBook.syncState(w.rid) : '(no state)';
    console.log(`#1182 after Y's late certificate: the read ${again.kept ? 'KEPT, nobody asked' : `read again (${asked} seats asked, ${again.fresh} batch(es) taken)`}; batch X held: ${held().includes(String(kX))}; state ${state}`);
    assert.equal(again.kept, undefined, 'the kept read was used after the book moved');
    assert.ok(asked >= 1);
    assert.equal(held().includes(String(kX)), true, 'batch X is taken on the read again');
    assert.equal(reader.orderBook.syncState(w.rid), 'KEPT', 'and that read is kept until the book moves again');
  } finally { await w.close(); }
});
