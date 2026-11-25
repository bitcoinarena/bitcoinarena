// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit attest-a8-2-1: A CONTRADICTION HANDED IN JUST BEFORE THE DEADLINE SPLITS THE SEATS VOID / FINAL (gap in #1787 / #2423).
// #2423 lets a seat take an attestation that a settlement peer proves it took before the deadline, so an outcome handed on across
// the deadline lands on every seat alike. A CONTRADICTION (a second standing attestation of another outcome - one fixed attestor of a
// 2-of-3 market co-signing the other side of an honest near tie, or a scalar market's #3260 equivocation) has no such door: seat a
// takes it a moment before the deadline and goes VOID (dispute) at once; its hand-on reaches seat b a moment after the deadline,
// b refuses it as late (outcomeTakenByPeer asks its peers for ATTESTED on that outcome - a says DISPUTED) and b goes FINAL on the
// first outcome. Seat a VOID, seat b FINAL, both terminal: neither the settlement nor the return door reaches its threshold.
// SAFE: both seats of the market end on the same state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const STAKE = 1_000_000n;
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Is BTC/USD up?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const MARKET = testAttestedGame({ name: 'btc-updown-a8-2-1', outcomes: ['Up', 'Down'], marketTerms: TERMS });
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 60000n };
const [A0, A1, A2] = MARKET.attestors;   // A2: the one faulty attestor, co-signing both sides of an honest near tie
const player = (n) => ({ ...LOSER, name: `a821-${n}`, key: b32(0x61 + n), worldSecret: b32(0) });

test('audit attest-a8-2-1: a contradiction posted to one seat just before the deadline leaves that seat VOID and its peer FINAL', { timeout: 170000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  const deadlineMs = Number(w.c.entryCloseMs) + 120000;
  // THE NETWORK: a seat's hand-on POST to its peer takes 100 ms (modelled on the test clock: the clock moves on while it is in flight)
  let latency = false;
  globalThis.fetch = (u, o = {}) => {
    if (latency && String(u).includes(`:${w.b.port}/outcome`) && String((o && o.method) || 'GET').toUpperCase() === 'POST') { skipTo(deadlineMs + 50); latency = false; }
    return realFetch(u, o);
  };
  try {
    for (const [i, pick] of [0, 1].entries()) await lockAndPlay(w, player(i), { noMarks: true, pick });
    await closeRound(w, { window: false });
    const observedAtMs = w.c.entryCloseMs + 60000n;
    const up = { roundId: w.rid, outcome: 0, observedAtMs }, down = { roundId: w.rid, outcome: 1, observedAtMs };
    const upBytes = encodeAttestation({ ...up, signatures: [A0, A2].map((a) => attestorSign(a, up)) });
    const downBytes = encodeAttestation({ ...down, signatures: [A1, A2].map((a) => attestorSign(a, down)) });
    const post = (d, bytes) => realFetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: bytes }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 160)}`);
    // the honest daemon's attestation (Up, A0 + A2), timely, at both seats
    skipTo(Number(observedAtMs) + 2000);
    const upA = await post(w.a, upBytes), upB = await post(w.b, upBytes);
    // the faulty attestor holds back the other side (Down, A1 + A2) and posts it to seat a 50 ms before the deadline
    skipTo(deadlineMs - 50);
    latency = true;
    const downA = await post(w.a, downBytes);
    await wait(3000);
    // and to seat b too, as anyone may, after the deadline (inside #2423's grace)
    const downB = await post(w.b, downBytes);
    skipTo(deadlineMs + 600000 + 60000);
    const stateOf = async (d) => { const o = await (await realFetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`)).json(); return `${o.market || o.state}${o.reason ? `/${o.reason}` : ''}`; };
    const states = [await stateOf(w.a), await stateOf(w.b)];
    console.log('  audit attest-a8-2-1:', JSON.stringify({ upA, upB, downA, downB, states }));
    assert.match(upA, /^20[01]/); assert.match(upB, /^20[01]/); assert.match(downA, /^20[01]/, 'seat a took the contradiction before the deadline');
    assert.equal(states[0], states[1], `a contradiction posted just before the deadline split the market: seat a ${states[0]}, seat b ${states[1]}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
