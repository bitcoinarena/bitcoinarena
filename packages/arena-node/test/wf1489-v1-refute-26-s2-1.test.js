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

// kanban #1489 refute of #1519 (skeptic 2): #decide's new DECIDED branch takes ANY threshold certificate a seat answers for "another
// set" without checking it is a certificate OF BATCH k. One dishonest seat (any peer, not a leader) answers the void ask for a partly
// signed batch k1 with the genuine certificate of an earlier batch k0 (public, GET /book-certificates). k1 is never voided: the seats that
// signed it hold it pending for good and sign no later batch (#signGuard), so the book freezes.

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

test('a seat answering a void ask with the certificate of another batch does not keep a half-signed batch from being voided', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const B = 1000;
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const at = async (k) => { while (testNow() < (k + 1) * B) await wait(5); };
    const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    // k0: certified honestly - its certificate is what the dishonest seat replays
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 52000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const k0 = Math.floor(testNow() / B);
    await at(k0);
    const first = await leaderOf(k0).orderBook.lead(w.rid, k0);
    assert.equal(first.certified, true, `batch ${k0} was not certified: ${first.why}`);
    const cert0 = leaderOf(k0).orderBook.certificates(w.rid).find((c) => c.k === String(k0));
    // k1: its leader's set reaches only one other seat (the network lost the rest) - 2 signatures, never a threshold
    await lockAndPlay(w, player(3), { noMarks: true, pick: YES, order: { price: 51000n } });
    await lockAndPlay(w, player(4), { noMarks: true, pick: NO, order: { price: 49000n } });
    const k1 = Math.floor(testNow() / B);
    await at(k1);
    const L1 = leaderOf(k1);
    let k2 = k1 + 1; while (leaderOf(k2) === L1) k2++;
    const L2 = leaderOf(k2);
    const A = w.nodes.find((d) => d !== L1 && d !== L2);
    const bad = w.nodes.find((d) => d !== L1 && d !== L2 && d !== A);
    const o1 = L1.orderBook.fetcher;
    L1.orderBook.fetcher = async (u, o) => (String(u).includes('/batch?round=') && !String(u).includes(`:${A.port}/`)) ? new Response('lost', { status: 503 }) : o1(u, o);
    const half = await L1.orderBook.lead(w.rid, k1);
    assert.equal(half.ok, true, half.why);
    assert.equal(half.certified, false);
    assert.deepEqual(A.orderBook.pending(w.rid), [k1], 'seat A holds k1 signed');
    L1.orderBook.fetcher = o1;
    // k2: the dishonest seat answers k1's void ask with k0's certificate and refuses to sign k2
    await at(k2);
    const o2 = L2.orderBook.fetcher;
    L2.orderBook.fetcher = async (u, o) => {
      if (String(u).includes(`:${bad.port}/batch-void-ask`)) return json({ ok: true, seat: toHex(bad.orderBook.round.pubkey), batchId: first.batchId, certificate: cert0.sigs });
      if (String(u).includes(`:${bad.port}/batch?round=`)) return new Response('no', { status: 409 });
      return o2(u, o);
    };
    const got = await L2.orderBook.lead(w.rid, k2);
    const d1 = (got.decided || []).find((d) => String(d.k) === String(k1));
    assert.ok(d1, `batch ${k1} was not decided at all: ${got.why}`);
    assert.equal(d1.state, 'VOID', `half-signed batch ${k1} was "${d1.state}" (${d1.why}) on another batch's certificate: never voided`);
    assert.deepEqual(A.orderBook.pending(w.rid), [], `seat A still holds batch ${k1} pending and signs no later batch`);
  } finally { await w.close(); }
});
