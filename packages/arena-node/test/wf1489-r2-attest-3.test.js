// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (order books): ONE PLAYER'S FREE SELLS STALL EVERY BATCH OF THE MARKET.
// POST /sell (order-batch.js ask) keeps any sell its entry's session key signed - a fresh nonce is a fresh sell - with no bound per entry and
// no check that the entry holds a share. A sell of shares the entry does not hold is refused only inside the ledger, by the leader, and is
// LEFT OUT of the batch: it stays unbatched at every seat for ever (until the close). So every batch from then on, each seat's GET
// /batch-proposal hands the leader all of them, the leader checks each one's Ed25519 signature again for every proposal (#sellStands) and
// runs the ledger over them - and a batch that should be certified inside its 0.5 s interval takes seconds, every interval, for the whole
// market. It costs the player one small order and nothing per sell (no lock, no fee: a sell that never fills owes nothing).
// SAFE: the seats bound what one entry keeps pending (or refuse a sell its entry cannot back), so a batch still certifies inside its interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const SELLS = 3000;
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489-r2-attest-3: one entry\'s unbacked sells do not hold every later batch past its interval', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const batch = async () => {
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const t0 = Date.now();
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    return { k, ms: Date.now() - t0, ...got };
  };
  try {
    // a baseline batch: two crossing orders
    await order(1, YES, 60); await order(2, NO, 55);
    const base = await batch();
    assert.equal(base.certified, true, base.why);
    // the attacker: one resting order that holds no share, and SELLS sells of it at every seat (each its own nonce, signed by its own key)
    const A = await order(0, YES, 10);
    const a0 = await batch();
    let kept = 0;
    for (let i = 0; i < SELLS; i++) {
      const s = { entry: toHex(A.eid), outcome: YES, price: '90000', sharesMsat: '1000', nonce: String(i + 1) };
      s.signature = toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: A.eid, outcome: YES, price: 90000n, sharesMsat: 1000n, nonce: BigInt(i + 1) }), A.session));
      for (const d of w.nodes) { const g = d.orderBook.ask(w.rid, 'sell', s); if (g.ok && d === w.nodes[0]) kept++; }
    }
    // honest players trade again
    await order(3, YES, 61); await order(4, NO, 56);
    const after = await batch();
    const pendingSells = w.nodes[0].orderBook.proposal(w.rid, after.k + 1).sells.length;
    console.log('  MEASURED:', JSON.stringify({ baselineLeadMs: base.ms, attackerFirstBatch: a0.certified, sellsKeptPerSeat: kept, afterLeadMs: after.ms, afterCertified: after.certified,
      sellsInBatch: after.sells, stillPendingAtSeat0: pendingSells, intervalMs: B }));
    assert.equal(after.certified, true, after.why);
    assert.ok(after.ms < B, `with ${kept} unbacked sells of one entry pending, a batch took ${after.ms} ms to certify (interval ${B} ms; baseline ${base.ms} ms)`);
  } finally { await w.close(); }
});
