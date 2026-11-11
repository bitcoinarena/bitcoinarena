// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1411 (audit 5 #1399), RULED #1417 (§0A.7b): a two-outcome round could hold backed orders and backed plain picks, and each seat decided book
// or pool from the stakes it had seen - one type's stakes waited for their lock timeout and seats planned differently. Now a round is a book iff a
// threshold-certified batch holds an order (the same at every seat); a plain pick in a book is not an entry of it and its lock comes back at once.
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

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-kind', outcomes: [...UP_DOWN_OUTCOMES] });
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `k${n}`, key: b32(0x50 + n), worldSecret: b32(0) });
const took = (p) => p.then((e) => ({ ok: 'taken', e }), (e) => ({ ok: String(e.message).slice(0, 110) }));
const B = 500;

test('#1411 a backed pick and a backed order: a pool until a batch is certified, then a book at every seat; the pick is refused after and its lock comes back at once', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 3, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const facts = {};
  try {
    skipTo(Number(w.c.committeeTimeMs) + 100);
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const pick = await took(lockAndPlay(w, player(1), { noMarks: true, pick: YES }));
    const order = await took(lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 55_000n } }));
    facts.pick = pick.ok; facts.orderAfterBackedPick = order.ok;
    facts.kindBeforeBatch = w.nodes.map((d) => d.orderBook.isBook(w.rid));
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    facts.batch = got.ok ? (got.certified ? 'certified' : 'signed') : got.why;
    for (const d of w.nodes) await d.orderBook.sync(w.rid, { force: true }).catch(() => null);
    facts.kindAfterBatch = w.nodes.map((d) => d.orderBook.isBook(w.rid));
    facts.pickAfterBook = (await took(lockAndPlay(w, player(3), { noMarks: true, pick: YES }))).ok;
    if (pick.e && pick.e.eid) {
      const base = `http://127.0.0.1:${w.nodes[0].port}`;
      facts.pickStanding = w.nodes[0].orderBook.standing(w.rid, pick.e.eid).wrongType ? 'wrong type' : 'entry';
      const r = await fetch(`${base}/forfeit?round=${toHex(w.rid)}&entry=${toHex(pick.e.eid)}`);
      facts.pickLockBack = r.status === 200 ? 'signed at once' : `${r.status} ${(await r.text()).trim().slice(0, 120)}`;
    }
  } finally { await w.close(); }
  console.log('  MEASURED #1411:', JSON.stringify(facts));
  assert.equal(facts.pick, 'taken');
  assert.equal(facts.orderAfterBackedPick, 'taken', 'an order was refused for a backed pick: the kind is the certified batches\'');
  assert.deepEqual(facts.kindBeforeBatch, [false, false, false], 'a book before any certified batch');
  assert.equal(facts.batch, 'certified', `the batch: ${facts.batch}`);
  assert.deepEqual(facts.kindAfterBatch, [true, true, true], 'the seats disagree on the kind after the certified batch');
  assert.match(facts.pickAfterBook, /order book: it takes orders, not a plain pick/);
  assert.equal(facts.pickStanding, 'wrong type');
  assert.equal(facts.pickLockBack, 'signed at once', `the pick's lock was not returned at once: ${facts.pickLockBack}`);
});
