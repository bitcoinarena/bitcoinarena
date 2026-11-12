// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 60 (kanban #1686 variant 2): ONE ROUND SEAT'S PADDED GET /batch-proposal ANSWER HOLDS THE LEADER'S EVENT LOOP.
// #1686 bounded the doors (certify, applyVoid) to the round's seats, but #counted itself still verifies every distinct (seat, signature)
// pair it is handed. lead() reads every peer's proposal and pushes one { seat: p.seat, signature: x.ownSig } per `pending` item into
// q.sigs - no bound on the list, no one-item-per-seat rule - and #decide hands q.sigs to #counted. One seat lists the real pending batch
// (its leader's signature is genuine, so #pendingStands passes) 20,000 times, each with a junk ownSig: 20,000 BIP-340 verifies.
// SAFE: the leader's event loop is held well under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-a44r60b', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const N = 20000;
const player = (n) => ({ ...LOSER, name: `r${n}`, key: b32(0xd0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489 a44 refute 60-2: one seat\'s padded proposal does not hold the leader\'s event loop', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  const untilCutoff = async (k, extra = 20) => { while (testNow() < (k + 1) * B + extra) await wait(5); };
  try {
    const R = await lockAndPlay(w, player(2), { noMarks: true, pick: YES, order: cents(70) });
    const S = await lockAndPlay(w, player(3), { noMarks: true, pick: NO, order: cents(35) });
    const kD = Math.floor(testNow() / B) + 1;
    await untilCutoff(kD);
    const L = leaderOf(kD);
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(kD), orderIds: ids });
    const record = { k: String(kD), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const two = w.nodes.filter((d) => d !== L).slice(0, 2);
    for (const d of [L, ...two]) {
      const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
      assert.equal(r.status, 201, await r.text());
    }
    const next = leaderOf(kD + 1);
    // THE PADDING SEAT: one round seat other than the next leader; its answer to the leader's void ask is padded
    const M = w.nodes.find((d) => d !== next && d !== L && !two.includes(d));
        const pending = [];
    for (let i = 0; i < N; i++) pending.push({ k: String(kD), batchId: toHex(id), record, ownSig: toHex(new Uint8Array(randomBytes(64))) });
    const honest = next.orderBook.fetcher;
    next.orderBook.fetcher = async (u, o) => {
      if (String(u).startsWith(`${base(M)}/batch-proposal`)) {
        return new Response(JSON.stringify({ seat: toHex(M.round.pubkey), k: String(kD + 1), orders: [], cancels: [], sells: [], pending }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return honest(u, o);
    };
    await untilCutoff(kD + 1);
    let gap = 0, last = Date.now();
    const tick = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 10);
    const t0 = Date.now();
    const led = await next.orderBook.lead(w.rid, kD + 1);
    const ms = Date.now() - t0;
    clearInterval(tick);
    console.log('MEASURED', JSON.stringify({ padded: N, leadMs: ms, loopHeldMs: gap, decided: (led.decided || []).map((d) => [d.k, d.state]), why: led.why || null }));
    assert.ok(gap < 1000, `one seat's padded proposal held the leader's event loop ${gap} ms (${N} junk signatures verified one by one in #counted)`);
  } finally { await w.close(); }
});
