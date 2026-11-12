// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 2 of fix:attest:2 (791ecbbab, a cancel only of an order the book holds): A STRANGER'S CANCELS NOW STAY FOREVER.
// The /entry door takes an order with no lock (no sat spent), and POST /cancel takes its cancel at every seat (no "tradable" check, unlike
// a sell, #1526). Such an order never makes a batch, so after the fix lead() leaves its cancel out of every set, and the cancel stays
// unbatched at every seat until the close: in every seat's proposal, verified again (Ed25519) per proposal at every lead, and the
// refused-cancel filter is quadratic. Before the fix it rode once in the next batch (a no-op in the ledger) and was gone. The same shape
// as #1547 (a sell that could never be backed, stuck in every proposal, stalled every later batch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { cancelId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489s2', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const JUNK = Number(process.env.WF_JUNK || 24);
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x40 + (n % 180)), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489-s2-1: a stranger\'s cancels of lockless orders do not stay in every proposal of every batch until the close', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  try {
    // honest trade, so every batch has work
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: cents(40) });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: cents(70) });
    // THE STRANGER: JUNK lockless orders through the real /entry door at every seat (only: [] - no seat is handed a lock), each cancelled
    const statuses = new Set();
    for (let i = 0; i < JUNK; i++) {
      const s = await lockAndPlay(w, player(10 + i), { noMarks: true, pick: YES, order: cents(30), only: [] });
      const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: s.eid }), s.session);
      for (const d of w.nodes) statuses.add((await fetch(`${base(d)}/cancel?entry=${toHex(s.eid)}`, { method: 'POST', body: sig })).status);
    }
    const pendingCancels = () => w.nodes.map((d) => d.orderBook.proposal(w.rid, Math.floor(testNow() / B) + 1).cancels.length);
    const leads = [];
    for (let i = 0; i < 4; i++) {
      const k = Math.floor(testNow() / B);
      while (testNow() < (k + 1) * B + 20) await wait(5);
      const t0 = Date.now();
      const led = await leaderOf(k).orderBook.lead(w.rid, k);
      leads.push({ k, ms: Date.now() - t0, ok: led.ok, empty: !!led.empty, certified: led.certified, cancels: led.cancels, why: led.why, pendingAfter: pendingCancels() });
    }
    console.log('  wf1489-s2-1:', JSON.stringify({ junk: JUNK, statuses: [...statuses], leads }));
    assert.ok(statuses.has(202) || statuses.has(200), `the door refused the stranger's cancels: ${[...statuses]}`);
    const last = leads[leads.length - 1].pendingAfter;
    assert.ok(Math.max(...last) === 0, `after ${leads.length} batches every seat still holds ${Math.max(...last)} of the stranger's ${JUNK} cancels unbatched: each is handed to every leader, verified again per proposal, in every batch until the close`);
  } finally { await w.close(); }
});
