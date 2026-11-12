// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit round 9 (market): A CANCEL IS ONE ID PER ENTRY (cancelId(round, entry)), so once an entry's cancel was
// carried by a certified batch, every sell that entry places later can never be cancelled: POST /cancel answers 200 { inNextBatch: true }
// (INSERT OR IGNORE, the event already batched), no leader carries it again (eventBatched), and the resting sell fills later against a new
// buyer. The state "entry cancelled + a later sell resting" can only be left by a fill or the close; the door's answer lies about its effect.
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
import { cancelId, sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-sm9m1', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489 sm9 market 1: a sell placed after the entry\'s cancel was batched can be cancelled (or the cancel is refused, not answered "in the next batch")', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const batch = async () => {
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, got.why);
    return { ...got, k };
  };
  const pos = (e) => w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(e.eid));
  const signSell = (e, sharesMsat, price, nonce) => ({ entry: toHex(e.eid), outcome: YES, price: String(price), sharesMsat: String(sharesMsat), nonce: String(nonce),
    signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: e.eid, outcome: YES, price: BigInt(price), sharesMsat: BigInt(sharesMsat), nonce: BigInt(nonce) }), e.session)) });
  const cancel = (e) => Promise.all(w.nodes.map(async (d) => {
    const r = await fetch(`${base(d)}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session) });
    return { status: r.status, body: await r.text() };
  }));
  const sell = async (s) => Promise.all(w.nodes.map((d) => fetch(`${base(d)}/sell?round=${rid}`, { method: 'POST', body: JSON.stringify(s) }).then((r) => r.status)));
  try {
    // A buys Up at 0.60 against B's Down at 0.45: A holds Up shares
    const A = await order(0, YES, 60);
    await order(1, NO, 45);
    const b1 = await batch();
    assert.equal(b1.certified, true);
    assert.ok(pos(A).shares[YES] > 0n, 'A filled');
    // A offers 5 sat of Up at 0.70 (no bid there: it rests), then cancels: the batch carries the cancel and takes the sell out
    await sell(signSell(A, 5000n, 70000n, 1n));
    assert.equal((await batch()).certified, true);
    await cancel(A);
    const bc = await batch();
    assert.equal(bc.certified, true);
    assert.equal(bc.cancels, 1);
    // A changes its mind and offers again: either the sell rests (and must be cancellable), or - kanban #2283, the cancel is final for
    // its entry - every seat refuses it and no batch carries it
    const again = await sell(signSell(A, 5000n, 70000n, 2n));
    console.log('  MEASURED sell after the batched cancel answers:', JSON.stringify([...new Set(again)]));
    const bs = await batch();
    if (again.every((st) => st >= 400)) assert.ok(bs.empty || !bs.sells, 'a sell every seat refused is in no batch');
    else { assert.equal(bs.certified, true); assert.equal(bs.sells, 1); }
    const soldBefore = pos(A).shares[NO];
    // A cancels that sell: every seat answers - but does any batch carry it?
    const second = await cancel(A);
    console.log('  MEASURED second cancel answers:', JSON.stringify([...new Set(second.map((x) => `${x.status} ${x.body}`))]));
    const accepted = second.some((x) => x.status >= 200 && x.status < 300);
    // a buyer for Up at 0.75 arrives
    await order(5, YES, 75);
    await batch();
    await batch();
    const soldAfter = pos(A).shares[NO];
    console.log('  MEASURED A sold after its accepted cancel:', String(soldAfter - soldBefore), 'msat of shares');
    // THE INVARIANT: a cancel the door accepted ("inNextBatch") takes the entry's resting sell out; a sell nobody can cancel must be refused at the door
    if (accepted) assert.equal(soldAfter - soldBefore, 0n, 'the seats answered A\'s cancel "in the next batch", and its resting sell filled after it');
  } finally { await w.close(); }
});
