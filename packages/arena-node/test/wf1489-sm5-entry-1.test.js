// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm5-find-entry 1 (state machine audit, entry): A SEAT THAT CATCHES UP MORE THAN 12 BLOCKS AFTER AN ORDER WAS LOCKED CAN NEVER
// HOLD IT. A certified batch names orders whose locks a threshold of seats verified in time. A seat that never received one (down, restarting,
// a lost post) replays it from a peer (order-batch.js #take -> server.js replayOrder -> takeStakeLock -> verifyStakeLock), and the replay runs
// the first-verification freshness rule again (lockMatchesEntry: lock height no more than STAKE_LOCK_FRESHNESS_BLOCKS = 12 below the height it
// is verified at). Once 12 blocks have passed since the order was locked (two hours, or one testnet4 burst), every replay is refused, and the
// replay gate stops asking: that seat refuses the certified batch for good, keeps another book and builds another settlement than the seats
// that hold it. The rule protects nothing here - the threshold already took that lock in time.
// Safe behaviour: a seat that catches up late still takes a certified batch's order and its locks, and holds the same book as the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `sm5e${n}`, key: b32(0x70 + n), worldSecret: b32(0) });

test('#1489 sm5-entry-1: a seat that catches up 100 blocks after an order was locked still takes the certified batch that names it', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = 1000;
    // two crossing orders, locked at height H and verified at every seat
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 55_000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50_000n } });
    const B = 1000, k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, got.why);
    assert.equal(got.certified, true, `batch ${k} was not certified: ${JSON.stringify(got.refused)}`);

    // SEAT 2 NEVER RECEIVED ONE ORDER OF THAT BATCH (it was down); the loss is simulated in this test's own in-memory store
    const d = w.nodes.find((x) => x !== leader);
    const cert = d.orderBook.certificates(w.rid).find((c) => c.record.orders.length);
    const eid = cert.record.orders[0], e = Buffer.from(eid, 'hex'), rid = Buffer.from(w.rid);
    d.round.db.exec('PRAGMA foreign_keys = OFF');
    for (const [t, col, v] of [['entries', 'entry_id', e], ['stake_locks', 'entry_id', e], ['fee_locks', 'entry_id', e], ['stake_seen', 'entry_id', e], ['market_orders', 'order_id', eid]])
      d.round.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(v);
    d.round.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, Number(cert.record.k));
    d.round.db.exec('PRAGMA foreign_keys = ON');

    // IT CATCHES UP 100 BLOCKS LATER (a seat down for ~17 h on mainnet, less on testnet4); the lock is still held in the federation
    const lockedAt = w.port.height;
    w.port.height += 100;
    await d.orderBook.carry(w.rid);
    await d.orderBook.carry(w.rid);
    const books = await Promise.all(w.nodes.map((x) => fetch(`http://127.0.0.1:${x.port}/book?round=${toHex(w.rid)}`).then((r) => r.json())));
    const held = d.orderBook.certificates(w.rid).some((c) => String(c.record.k) === String(cert.record.k));
    console.log('  FACTS:', JSON.stringify({ lockedAt, catchUpHeight: w.port.height, entryReplayed: !!d.round.entry(e), stakeLockHeld: !!d.round.stakeLock(e),
      batchHeldHere: held, batchesHere: books[w.nodes.indexOf(d)].batches.length, batchesAtLeader: books[w.nodes.indexOf(leader)].batches.length }));
    assert.ok(d.round.stakeLock(e), 'the certified order\'s stake lock was refused at the replay: this seat can never hold that order');
    assert.ok(held, 'the certified batch is not held at the seat that caught up');
    assert.equal(JSON.stringify(books[w.nodes.indexOf(d)].batches), JSON.stringify(books[w.nodes.indexOf(leader)].batches), 'two seats hold the book differently');
  } finally { await w.close(); }
});
