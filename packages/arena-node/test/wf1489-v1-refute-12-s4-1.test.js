// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 4 of fix:attest:2 (791ecbbab + 91d11feb2): AN HONEST SEAT THAT MISSED A CERTIFICATE NOW REFUSES EVERY HONEST BATCH
// CARRYING A CANCEL OF AN ORDER FROM THAT BATCH. A seat that was unreachable while batch k1 was signed and certified (n - needed of them
// may be) holds nothing of k1 and reads it only after the close (server.js: book sync at close). Before the fix it signed batch k2 with
// X's cancel (its ledger skipped the cancel, the others applied it); now #check refuses the whole set ("a cancel of that batch does not
// stand"). The book's fault margin is gone for every batch from then on: one more slow seat and the set (every player's orders) is void,
// again at every batch, because every honest proposal carries the cancel again - the book stalls until the close.
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
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489s4', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `q${n}`, key: b32(0xd0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489-s4-1: a seat that missed batch k1 (honest, unreachable then) still signs an honest batch carrying a cancel of k1\'s order', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  try {
    const X = await order(1, YES, 40);
    // BATCH k1 (X's order), signed and certified by the seats the leader reached: two seats were unreachable then
    const k1 = Math.floor(testNow() / B);
    while (testNow() < (k1 + 1) * B + 20) await wait(5);
    const L1 = leaderOf(k1), L2 = leaderOf(k1 + 2);
    const lagging = w.nodes.filter((d) => d !== L1 && d !== L2).slice(0, w.nodes.length - w.needed);
    const reached = w.nodes.filter((d) => !lagging.includes(d));
    const record = { k: String(k1), orders: [toHex(X.eid)], cancels: [], sells: [], leader: toHex(L1.round.pubkey) };
    record.leaderSig = toHex(schnorr.sign(bookBatchId({ roundId: w.rid, k: BigInt(k1), orderIds: record.orders }), L1.round.identity.secret));
    const answers = await Promise.all(reached.map(async (d) => { const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) }); return r.ok ? r.json() : null; }));
    const sigs = answers.filter(Boolean).map((a) => ({ seat: a.seat, signature: a.signature }));
    const certK1 = (await Promise.all(reached.map((d) => fetch(`${base(d)}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify({ record, sigs }) }).then((r) => r.ok)))).filter(Boolean).length;
    // X's player cancels at every seat
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: X.eid }), X.session);
    const told = await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/cancel?entry=${toHex(X.eid)}`, { method: 'POST', body: sig }).then((r) => r.status)));
    // BATCH k2: an honest leader, every seat reachable, carries X's cancel
    const k2 = k1 + 2;
    while (testNow() < (k2 + 1) * B + 20) await wait(5);
    const led = await L2.orderBook.lead(w.rid, k2);
    const facts = { needed: w.needed, signedK1: sigs.length, certK1, told: [...new Set(told)], k2: { cancels: led.cancels, heldBy: led.heldBy, of: led.of, certified: led.certified, refused: led.refused } };
    console.log('  wf1489-s4-1:', JSON.stringify(facts));
    assert.equal(certK1, w.needed);
    assert.equal(led.cancels, 1, 'the honest batch k2 carries X\'s cancel');
    // THE MARGIN: honest seats sign an honest set; before the fix all 7 did (heldBy 7). With one more seat slow, k2 would be void.
    assert.equal(led.heldBy, w.nodes.length, `honest seats that missed batch ${k1} refused the honest batch ${k2}: ${JSON.stringify(led.refused)}`);
  } finally { await w.close(); }
});
