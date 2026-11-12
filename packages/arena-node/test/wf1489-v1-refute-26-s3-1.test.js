// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO, bookBatchId } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// kanban #1489 refute of #1519/#1697/#1886 (skeptic 3): the DECIDED branch covers a leader that signed two sets when the threshold signed
// one of them. A leader of batch k1 that signs two sets and splits the six honest seats 3/3 gets NEITHER set certified (4 of 5 each,
// its own signature on both) and no seat declines (every honest seat signed one set). #decide finds no threshold, no certificate of
// k1 and 0 declines: k1 stays PENDING at every leader, the honest seats hold it signed and sign no later batch (#signGuard) - one
// dishonest seat freezes the book for good, the effect #1519 closed for a forged pending item.

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });

test('a leader that signs two sets for its batch and splits the seats between them does not freeze the book', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const B = 1000;
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const at = async (k) => { while (testNow() < (k + 1) * B) await wait(5); };
    const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 52000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const k1 = Math.floor(testNow() / B);
    await at(k1);
    const bad = leaderOf(k1);
    const badPub = toHex(bad.orderBook.round.pubkey);
    const orders = bad.orderBook.proposal(w.rid, k1).orders;
    assert.ok(orders.length >= 1, 'the leader holds the orders tradable');
    // two sets for k1, both signed by k1's leader: A with the orders, B with one of them
    const sign = (ids) => {
      const rec = { k: String(k1), orders: ids, cancels: [], sells: [], leader: badPub };
      rec.leaderSig = toHex(schnorr.sign(bookBatchId({ roundId: w.rid, k: BigInt(k1), orderIds: ids }), bad.orderBook.round.identity.secret));
      return rec;
    };
    const A = sign([...orders]), Bset = sign([orders[0]]);
    const honest = w.nodes.filter((d) => d !== bad);
    assert.equal(bad.orderBook.accept(w.rid, A).ok, true);
    for (const [i, d] of honest.entries()) {
      const r = d.orderBook.accept(w.rid, i < 3 ? A : Bset);
      assert.equal(r.ok, true, `seat ${i} signs: ${r.why}`);
    }
    // k2: the next honest leader decides k1 first
    let k2 = k1 + 1; while (leaderOf(k2) === bad) k2++;
    await at(k2);
    const got = await leaderOf(k2).orderBook.lead(w.rid, k2);
    assert.equal(got.ok, true, `one leader's two sets for batch ${k1} stopped batch ${k2}: ${got.why}`);
    const d1 = (got.decided || []).find((d) => String(d.k) === String(k1));
    assert.ok(d1 && d1.state !== 'PENDING', `batch ${k1} is still pending`);
  } finally { await w.close(); }
});
