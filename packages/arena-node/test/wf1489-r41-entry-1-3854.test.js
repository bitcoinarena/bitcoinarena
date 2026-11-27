// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r41-entry-1 (attack audit, find-only): A FREE OPTION TO VOID A POOL MARKET. A pari-mutuel market (plain picks) becomes an order book as
// soon as one threshold-certified batch holds an order (§0A.7b as ruled in #1417 for 1.9), and every plain pick of a book is "wrongType": its
// stake and fee lock come back at once. So a player holding a losing plain pick waits until the outcome is all but known (an Up/Down round a few
// seconds before its entry close), posts ONE minimum order of his own (5 shares at 5 cents; unfilled, its locks also come back whole) and the
// next batch makes the round a book: the pool never pays - his losing pick is refunded and the honest winner's winnings are gone. Safe: once a
// round holds a backed plain pick, a late order does not turn its pool into a book (the honest pick stays an entry of a pool).
// kanban #3854 (ruling comment 11620, "pool first", protocol 35): a round of 35 with backed plain picks stays a pool at every seat, the
// order is no entry of it; orders only -> a book as before; a round below 35 keeps #1417 option B.
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
import { POOL_FIRST_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
// 2.0: 35 is spoken only once 34 is (constants.js POOL_FIRST_VERSION) - until then the protocol-35 cases are skipped, as genesis-run-3762's
const AT35 = !SUPPORTED_PROTOCOL_VERSIONS.includes(POOL_FIRST_VERSION) && 'protocol 35 is spoken on 2.0 only with 34 (#3612/#3680)';

// ON 2.0, 27 AND UP IS ALSO THE ARENA LOCK (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0): this fixture's locks are stock contracts, so its
// rounds sit below regtest's named-claim point by the harness switch, as wf1489-r20-h2h-1 and h2h-lock-set-2561 do (kanban #1489 port of #3854)
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-r41', outcomes: [...UP_DOWN_OUTCOMES] });
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `r41-${n}`, key: b32(0x60 + n), worldSecret: b32(0) });
const took = (p) => p.then((e) => ({ ok: 'taken', e }), (e) => ({ ok: String(e.message).slice(0, 110) }));
const B = 500;

async function run({ protocolVersion, picks = true }) {
  const w = await lockRound({ n: 3, stakeMsat: 10_000n, round: { ...ROUND, ...(protocolVersion ? { protocolVersion } : {}) }, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const facts = {};
  try {
    skipTo(Number(w.c.committeeTimeMs) + 100);
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    let honest = {}, loser = {};
    if (picks) {
      // the honest winner's plain pick (YES) and the attacker's losing plain pick (NO), both backed by locks
      honest = await took(lockAndPlay(w, player(1), { noMarks: true, pick: YES }));
      loser = await took(lockAndPlay(w, player(2), { noMarks: true, pick: NO }));
      facts.picks = [honest.ok, loser.ok];
    }
    // the attacker, seeing YES win, posts one order of his own (a fresh key, the minimum, no counterparty: it never fills)
    const order = await took(lockAndPlay(w, player(3), { noMarks: true, pick: NO, order: { price: 55_000n } }));
    facts.lateOrder = order.ok;
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    facts.batch = got.ok ? (got.certified ? 'certified' : 'signed') : got.why;
    for (const d of w.nodes) await d.orderBook.sync(w.rid, { force: true }).catch(() => null);
    facts.isBook = w.nodes.map((d) => d.orderBook.isBook(w.rid));
    facts.kindPending = w.nodes.map((d) => d.orderBook.kindPending(w.rid).length);
    if (order.e && order.e.eid) facts.order = w.nodes.map((d) => { const b = d.orderBook.standing(w.rid, order.e.eid); return b.filled ? 'filled' : b.pool ? 'pool: no entry' : 'unfilled'; });
    if (honest.e && honest.e.eid) {
      facts.honestPick = w.nodes.map((d) => (d.orderBook.standing(w.rid, honest.e.eid).wrongType ? 'wrong type: refunded' : 'entry of the pool'));
      const base = `http://127.0.0.1:${w.nodes[0].port}`;
      const r = await fetch(`${base}/forfeit?round=${toHex(w.rid)}&entry=${toHex(loser.e.eid)}`);
      facts.losersPickBack = r.status === 200 ? 'signed back at once' : `${r.status} ${(await r.text()).trim().slice(0, 100)}`;
    }
  } finally { await w.close(); }
  return facts;
}

test('r41-entry-1 (#3854): at protocol 35 a loser\'s last-second minimum order does not turn a pool with backed plain picks into a book', { timeout: 170000, skip: AT35 }, async () => {
  const facts = await run({ protocolVersion: POOL_FIRST_VERSION });
  console.log('  MEASURED r41-entry-1 v35:', JSON.stringify(facts));
  assert.deepEqual(facts.picks, ['taken', 'taken']);
  assert.equal(facts.lateOrder, 'taken', 'the door still takes the order (doors unchanged)');
  assert.equal(facts.batch, 'certified');
  assert.deepEqual(facts.isBook, [false, false, false],
    `one late order of ~5 shares turned the pool into a book (batch ${facts.batch}): the honest pick is ${JSON.stringify(facts.honestPick)}`);
  assert.deepEqual(facts.kindPending, [0, 0, 0], 'the kind is decided: a pool');
  assert.deepEqual(facts.honestPick, ['entry of the pool', 'entry of the pool', 'entry of the pool']);
  assert.deepEqual(facts.order, ['pool: no entry', 'pool: no entry', 'pool: no entry']);
  assert.notEqual(facts.losersPickBack, 'signed back at once', 'the loser\'s pick is not refunded');
});

test('r41-entry-1 (#3854): at protocol 35 a round of orders only is a book as before', { timeout: 170000, skip: AT35 }, async () => {
  const facts = await run({ protocolVersion: POOL_FIRST_VERSION, picks: false });
  console.log('  MEASURED r41-entry-1 v35 orders only:', JSON.stringify(facts));
  assert.equal(facts.batch, 'certified');
  assert.deepEqual(facts.isBook, [true, true, true]);
  assert.deepEqual(facts.order, ['unfilled', 'unfilled', 'unfilled']);
});

test('r41-entry-1 (#3854): a round below 35 keeps #1417 option B (a certified order makes it a book)', { timeout: 170000 }, async () => {
  const facts = await run({});
  console.log('  MEASURED r41-entry-1 old version:', JSON.stringify(facts));
  assert.deepEqual(facts.picks, ['taken', 'taken']);
  assert.deepEqual(facts.isBook, [true, true, true]);
  assert.deepEqual(facts.honestPick, ['wrong type: refunded', 'wrong type: refunded', 'wrong type: refunded']);
});
