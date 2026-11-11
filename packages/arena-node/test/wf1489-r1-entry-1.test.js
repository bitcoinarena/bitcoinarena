// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-find-entry 1: ONE SEAT OF SEVEN MUST NOT FREEZE THE ORDER BOOK. Every leader reads every seat's GET /batch-proposal and
// decides each `pending` batch named there before it batches anything new; a batch it can neither certify nor void is "still undecided"
// and lead() refuses. A single seat (role b) that lists a made-up pending batch (no leader signed it, nothing of it exists anywhere) in its
// proposal makes every leader's lead() refuse - for every batch, for the rest of the market: no order ever trades again.
// Safe behaviour: a pending batch whose record its own leader did not sign is ignored; the honest orders are certified.
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
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });

test('one seat listing a forged pending batch in its proposal does not stop the leader from certifying the honest orders', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const B = 1000;
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 52000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const bad = w.nodes.find((d) => d !== leader);           // the one dishonest seat
    const fakeK = String(k - 1);
    const fakeLeader = toHex(leader.orderBook.leaderOf(w.c, BigInt(fakeK)));
    const orig = leader.orderBook.fetcher;
    leader.orderBook.fetcher = async (u, o) => {
      const r = await orig(u, o);
      if (!String(u).includes(`:${bad.port}/batch-proposal`) || !r.ok) return r;
      const body = await r.json();
      body.pending = [...(body.pending || []), { k: fakeK, batchId: 'ab'.repeat(32), ownSig: '11'.repeat(64),
        record: { k: fakeK, orders: [], cancels: [], sells: [], leader: fakeLeader, leaderSig: '22'.repeat(64) } }];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, `one seat's forged pending batch stopped the book: ${got.why}`);
    assert.equal(got.certified, true, `batch ${k} was not certified`);
  } finally { await w.close(); }
});
