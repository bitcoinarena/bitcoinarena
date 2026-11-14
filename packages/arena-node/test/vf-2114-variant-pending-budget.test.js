// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 3 of #1547 (after b2b5975aa): the SECOND COPY of the sell check. #sellsWorthChecking bounds the sells of a
// proposal's `sells` list, but a proposal's `pending` items still run #recordId over their record's sells with no bound (#pendingStands).
// b2b5975aa checks the leaderSig over the claimed batchId first, assuming a forged item then costs one Schnorr verify - but the seat
// that serves the proposal is itself the leader of a k (every seat leads k = its index mod n), so it signs a record of its own k: the
// Schnorr check passes and #recordId verifies every sell's Ed25519 signature. The sells are signed by the session key of one cheap order
// the attacker holds (any order entry the seat holds: #sellVerify asks no lock and no share), a fresh nonce each batch (a cache miss).
// SAFE: one seat's pending list costs the leader a bounded number of signature checks; the batch certifies inside its interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bookBatchId, sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-s3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const SELLS = 112;   // kanban #2114 variant: at the per-record bound (7 seats x MAX_UNBATCHED_SELLS of one order)
const ITEMS = 64;    // records of as many of its own k's (PENDING_PER_PROPOSAL)
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('#2114 variant: one seat\'s pending items, records of 64 of its own k at the per-record bound, does not hold a batch past its interval', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const nextK = () => Math.floor(testNow() / B);
  const batch = async (k) => {
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const t0 = Date.now();
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    return { k, ms: Date.now() - t0, ...got };
  };
  let nonce = 0;
  try {
    await order(1, YES, 60); await order(2, NO, 55);
    const base = await batch(nextK());
    assert.equal(base.certified, true, base.why);
    const A = await order(0, YES, 10);   // the attacker's one order: its session key signs the sells
    await batch(nextK());
    const results = [];
    for (let r = 0; r < 2; r++) {
      await order(10 + 2 * r, YES, 61); await order(11 + 2 * r, NO, 56);
      const k = nextK() + 40;
      const bad = w.nodes.find((d) => !d.orderBook.leads(w.rid, k));
      // a k the bad seat leads itself, just before k (its cutoff passed by then, never led: the seats can decline it), signed as its leader
      const items = [];
      let kb = k - 1;
      for (let it = 0; it < ITEMS; it++, kb--) {
        while (!bad.orderBook.leads(w.rid, kb)) kb--;
        const sells = Array.from({ length: SELLS }, () => {
          nonce++;
          const id = sellId({ roundId: w.rid, entryId: A.eid, outcome: YES, price: 90000n, sharesMsat: 1000n, nonce: BigInt(nonce) });
          return { id: toHex(id), s: { entry: toHex(A.eid), outcome: YES, price: '90000', sharesMsat: '1000', nonce: String(nonce), signature: toHex(ed25519.sign(id, A.session)) } };
        });
        const bid = bookBatchId({ roundId: w.rid, k: BigInt(kb), orderIds: sells.map((x) => x.id) });
        items.push({ k: String(kb), batchId: toHex(bid), ownSig: null,
          record: { k: String(kb), orders: [], cancels: [], sells: sells.map((x) => x.s), leader: toHex(bad.orderBook.round.pubkey), leaderSig: toHex(schnorr.sign(bid, bad.orderBook.round.identity.secret)) } });
      }
      const orig = bad.orderBook.proposal.bind(bad.orderBook);
      bad.orderBook.proposal = (rid, kk) => { const p = orig(rid, kk); return { ...p, pending: [...(p.pending || []), ...items] }; };
      assert.ok(testNow() < k * B, 'the item was built before batch k opened');
      try { results.push(await batch(k)); } finally { bad.orderBook.proposal = orig; }
    }
    console.log('  MEASURED #2114 variant:', JSON.stringify({ baselineLeadMs: base.ms, sells: SELLS, items: ITEMS, rounds: results.map((x) => ({ ms: x.ms, certified: x.certified, decided: x.decided, why: x.why })), intervalMs: B }));
    for (const x of results) {
      assert.equal(x.certified, true, `lead() took ${x.ms} ms and the batch was not certified: ${x.why}`);
      assert.ok(x.ms < B, `one seat's pending record of its own k with ${SELLS} signed sells held the batch ${x.ms} ms (interval ${B} ms; baseline ${base.ms} ms)`);
    }
  } finally { await w.close(); }
});
