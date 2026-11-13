// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 STATE-MACHINE AUDIT, round 8, area entry (#1): a plain pick taken while its market was a pool, in a round that a certified batch then
// makes an order book (§0A.7b, #1411/#1417), "is no entry of that round: its lock is returned at once, as §23.2 REFUSED". §23.2 REFUSED returns the stake
// AND its fee lock (POST /refused-lock keeps both). Here only the stake comes back: forfeit.js gives the wrong-type return to kind 'stake' alone, the fee
// door (lock=fee) answers only for a cancelled order or a refunded market, and the book's settlement claims only the orders of its table - so the
// pick's fee lock (node fee + donation) is neither claimed nor returned by anyone: it lies in the federation until its expiry.
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

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-sm8', outcomes: [...UP_DOWN_OUTCOMES] });
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x60 + n), worldSecret: b32(0) });
const took = (p) => p.then((e) => ({ ok: 'taken', e }), (e) => ({ ok: String(e.message).slice(0, 110) }));
const B = 500;

test('#1489-sm8-entry-1 a plain pick that is no entry of a book gets its fee lock back with its stake', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 3, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const facts = {};
  try {
    skipTo(Number(w.c.committeeTimeMs) + 100);
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const pick = await took(lockAndPlay(w, player(1), { noMarks: true, pick: YES }));
    const order = await took(lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 55_000n } }));
    assert.equal(pick.ok, 'taken'); assert.equal(order.ok, 'taken');
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    assert.ok(got.ok && got.certified, `the batch: ${got.why || 'signed only'}`);
    for (const d of w.nodes) await d.orderBook.sync(w.rid, { force: true }).catch(() => null);
    facts.book = w.nodes.map((d) => d.orderBook.isBook(w.rid));
    const eid = pick.e.eid;
    facts.feeLockHeld = w.nodes.map((d) => !!d.round.feeLock(eid));
    facts.wrongType = w.nodes.map((d) => !!d.orderBook.standing(w.rid, eid).wrongType);
    const base = `http://127.0.0.1:${w.nodes[0].port}`;
    const ask = async (q) => { const r = await fetch(`${base}/forfeit?round=${toHex(w.rid)}&entry=${toHex(eid)}${q}`); return r.status === 200 ? 'signed at once' : `${r.status} ${(await r.text()).trim().slice(0, 160)}`; };
    facts.stakeBack = await ask('');
    facts.feeBack = await ask('&lock=fee');
  } finally { await w.close(); }
  console.log('  FACTS #1489-sm8-entry-1:', JSON.stringify(facts));
  assert.deepEqual(facts.book, [true, true, true]);
  assert.deepEqual(facts.feeLockHeld, [true, true, true], 'the pick\'s fee lock was not verified');
  assert.deepEqual(facts.wrongType, [true, true, true]);
  assert.equal(facts.stakeBack, 'signed at once', `the stake: ${facts.stakeBack}`);
  assert.equal(facts.feeBack, 'signed at once', `the stake came back as §23.2 REFUSED, and its fee lock - claimed by no settlement of the book - did not: ${facts.feeBack}`);
});
