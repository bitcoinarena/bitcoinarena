// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (attack, one seat): A CANCEL CARRIED IN A BATCH BEFORE ITS ORDER IS CONSUMED AND LOST. The ledger (book-ledger.js) refuses a
// cancel of an order the book does not hold yet, but OrderBook #check only refuses bad sells, so the seats sign and certify the batch,
// the cancel's event is marked batched for good (its id is cancelId(round, entry): the player can never cancel again) - and the order,
// left out by the leader, rides in the next honest batch and fills. The player was told "inNextBatch", the order trades anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, cancelId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `w${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489-1: a leader seat carrying a cancel without its order does not lose the cancel - the cancelled order never fills', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  const push = async (record) => {
    const answers = await Promise.all(w.nodes.map(async (d) => {
      const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
      return r.ok ? { ok: true, ...(await r.json()) } : { ok: false, why: `${r.status} ${(await r.text()).trim()}` };
    }));
    const sigs = answers.filter((a) => a.ok).map((a) => ({ seat: a.seat, signature: a.signature }));
    let certified = 0;
    if (sigs.length >= w.needed) {
      const took = await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify({ record, sigs }) }).then((r) => r.ok)));
      certified = took.filter(Boolean).length;
    }
    return { signed: sigs.length, certified, refused: answers.filter((a) => !a.ok).map((a) => a.why) };
  };
  try {
    // X bids Up at 0.40, Y bids Down at 0.70: they cross. Both locked, neither batched yet.
    const X = await order(1, YES, 40);
    const Y = await order(2, NO, 70);
    // X's player cancels at every seat: "inNextBatch"
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: X.eid }), X.session);
    const told = await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/cancel?entry=${toHex(X.eid)}`, { method: 'POST', body: sig }).then((r) => r.status)));
    // THE LEADER OF THE NEXT BATCH (one seat) carries X's cancel and leaves X's order out
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const L = leaderOf(k);
    const cancels = [{ entry: toHex(X.eid), signature: toHex(sig) }];
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: [toHex(cancelId({ roundId: w.rid, entryId: X.eid }))] });
    const record = { k: String(k), orders: [], cancels, sells: [], leader: toHex(L.round.pubkey) };
    record.leaderSig = toHex(schnorr.sign(id, L.round.identity.secret));
    const pushed = await push(record);
    // THE NEXT HONEST BATCH
    const k2 = Math.floor(testNow() / B);
    while (testNow() < (k2 + 1) * B + 20) await wait(5);
    const led = await leaderOf(k2).orderBook.lead(w.rid, k2);
    const p = w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(X.eid));
    const s = w.nodes[0].orderBook.standing(w.rid, X.eid);
    const facts = { told: [...new Set(told)], pushed, led: { certified: led.certified, orders: (led.orderIds || []).length }, xCost: p ? String(p.cost) : null, xCancelled: !!(p && p.cancelled), standing: s,
      yCost: String((w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(Y.eid)) || { cost: 0n }).cost) };
    console.log('  wf1489-1:', JSON.stringify(facts));
    assert.deepEqual(facts.told, [202]);
    // SAFE: either no seat signs a batch whose cancel the ledger refuses, or X - whose player cancelled before any batch - never fills
    assert.ok(pushed.certified === 0 || !(p && p.cost > 0n), `X's cancel was certified in batch ${k} without its order, and X filled ${facts.xCost} msat in batch ${k2}`);
    assert.ok(!(p && p.cost > 0n), `X filled ${facts.xCost} msat after its player cancelled it`);
  } finally { await w.close(); }
});
