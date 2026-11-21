// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 60 skeptic 2 (kanban #1686, variant 1): ONE PEER SEAT'S PADDED GET /book-certificates ANSWER HOLDS A SEAT'S
// EVENT LOOP ON THE SYNC / CARRY PATH (the read before every settlement, read again each pass while it is not kept).
// #1686 + #2175/#2253 bounded each signature list (certify.sigs, applyVoid.declines, #counted per call). But #take loops over
// every certificate a peer lists - no bound - and each one goes through certify -> #check -> #recordId, one BIP-340 verify of its
// leaderSig, before anything else. One round seat answers { certificates: [N x the same k, each a fresh junk leaderSig], pending: [] }:
// N verifies, synchronously; each fails ('not signed by its leader'), so none is held and the next sync pass verifies them all again.
// SAFE: the reading seat's event loop is held well under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-a44r60s2a', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const N = 20000;
const player = (n) => ({ ...LOSER, name: `r${n}`, key: b32(0xe0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489 a44 refute 60 s2-1: one peer seat padded /book-certificates does not hold the reader event loop', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  try {
    await lockAndPlay(w, player(2), { noMarks: true, pick: YES, order: cents(70) });
    const k = Math.floor(testNow() / B) + 1;
    const L = leaderOf(k);
    const R = w.nodes.find((d) => d !== L);              // the reading seat (runs sync/carry)
    const M = w.nodes.find((d) => d !== L && d !== R);   // the padding seat (one round seat)
    const certificates = [];
    for (let i = 0; i < N; i++) certificates.push({ k: String(k), record: { k: String(k), orders: [], cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(new Uint8Array(randomBytes(64))) }, sigs: [] });
    const honest = R.orderBook.fetcher;
    let served = 0;
    R.orderBook.fetcher = async (u, o) => {
      if (String(u).startsWith(`${base(M)}/book-certificates`)) { served += 1; return new Response(JSON.stringify({ certificates, pending: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      return honest(u, o);
    };
    let gap = 0, last = Date.now();
    const tick = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 10);
    const t0 = Date.now();
    const got = await R.orderBook.sync(w.rid, { force: true });
    await wait(1500);   // the padded answer is taken even if it lands after the threshold answered
    const ms = Date.now() - t0;
    clearInterval(tick);
    console.log('MEASURED', JSON.stringify({ padded: N, served, syncMs: ms, loopHeldMs: gap, got }));
    assert.ok(served >= 1, 'the padding seat was asked');
    assert.ok(gap < 1000, `one peer seat padded /book-certificates held the reading seat event loop ${gap} ms (${N} leaderSig verifies in #take -> certify -> #check)`);
  } finally { await w.close(); }
});
