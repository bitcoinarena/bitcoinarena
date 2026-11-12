// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1519: #pendingStands only asks that k's LEADER signed the pending record. A dishonest seat is itself the leader
// of every n-th batch, so it signs a record for a batch k' it leads LATER (inside the book window) and lists it pending. No seat signed it,
// and no seat declines a batch whose cutoff has not passed by an interval - so every leader before k' answers "still undecided".
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

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });

test('a seat listing a pending batch it signed itself for a batch it leads later does not stop the current leader', async () => {
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
    const bad = w.nodes.find((d) => d !== leader);
    let fk = k + 1; while (!bad.orderBook.leads(w.rid, fk)) fk++;   // a later batch the dishonest seat leads
    const badPub = toHex(bad.orderBook.round.pubkey);
    const record = { k: String(fk), orders: [], cancels: [], sells: [], leader: badPub };
    const id = bookBatchId({ roundId: w.rid, k: BigInt(fk), orderIds: [] });
    record.leaderSig = toHex(schnorr.sign(id, bad.orderBook.round.identity.secret));
    const orig = leader.orderBook.fetcher;
    leader.orderBook.fetcher = async (u, o) => {
      const r = await orig(u, o);
      if (!String(u).includes(`:${bad.port}/batch-proposal`) || !r.ok) return r;
      const body = await r.json();
      body.pending = [...(body.pending || []), { k: String(fk), batchId: toHex(id), record }];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, `one seat's self-signed future pending batch ${fk} stopped batch ${k}: ${got.why}`);
    assert.equal(got.certified, true, `batch ${k} was not certified`);
  } finally { await w.close(); }
});
