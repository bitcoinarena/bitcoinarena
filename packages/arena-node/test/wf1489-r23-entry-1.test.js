// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r23-entry-1: POST /batch-certificate (OrderBook.certify, #check with importing: true) skips #recordTooBig and runs
// #recordId - one Ed25519 verify and one entry decode per sell - BEFORE the leader's signature is checked. A stranger who holds one order
// (or any player) posts a "certificate" with thousands of his own freshly signed sells and a junk leaderSig: each POST blocks the seat's
// event loop for seconds and is refused only afterwards (403 "not signed by its leader").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-r23e1', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `r${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });

test('r23-entry-1: a batch certificate its leader never signed is refused without verifying thousands of sells', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  try {
    const X = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 40_000n } });
    const N = 4000;
    const sells = [];
    for (let i = 0; i < N; i++) {
      const s = { entry: toHex(X.eid), outcome: YES, price: '10000', sharesMsat: '1000', nonce: String(1000 + i) };
      s.signature = toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: X.eid, outcome: YES, price: 10000n, sharesMsat: 1000n, nonce: BigInt(s.nonce) }), X.session));
      sells.push(s);
    }
    const d = w.nodes[0];
    const k = Math.floor(testNow() / d.orderBook.intervalMs);
    const leader = toHex(w.nodes.find((x) => x.orderBook.leads(w.rid, k)).round.pubkey);
    const record = { k: String(k), orders: [], cancels: [], sells, leader, leaderSig: '11'.repeat(64) };
    const body = JSON.stringify({ record, sigs: [] });
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${d.port}/batch-certificate?round=${rid}`, { method: 'POST', body });
    const why = (await r.text()).trim();
    const ms = Math.round(performance.now() - t0);
    console.log('  r23-entry-1:', JSON.stringify({ sells: N, bodyBytes: body.length, status: r.status, why: why.slice(0, 120), ms }));
    assert.notEqual(r.status, 201);
    // SAFE: refused by count/leader before any per-sell signature work (an honest batch carries at most nodes x MAX_PROPOSAL_SELLS = 1792)
    assert.ok(ms < 1000, `one forged certificate held the seat ${ms} ms (${N} sell signatures verified before the leader's)`);
  } finally { await w.close(); }
});
