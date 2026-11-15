// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r7-attest-1: BYPASS OF #2423 (hand-on across the deadline). An attestation taken by seat a a second before the market's
// deadline D is handed on to seat b; when that post does not land before D (b restarting at that moment - the case #2423 was built for),
// b takes it later "handed on across the deadline", filed at a's time, and both seats go FINAL. But ANY READ of b's market state at or
// after D - a stranger's GET /outcome, or the losing player's own GET /forfeit - persists VOID on b first (marketStateOf, compare-and-set),
// and the hand-on that arrives a moment later is "evidence only". Seat a is FINAL, seat b VOID: the two seats of one market decide it
// differently, and the loser chose that by one GET.
// SAFE: a seat that persisted VOID at its deadline while a settlement peer took a standing attestation before that deadline still ends on
// the same state as that peer (both FINAL), as it does when nobody reads it in between.
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
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const TERMS_MARKET = testAttestedGame({ name: 'btc-close-terms-r7a1', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
const ROUND = { gameId: TERMS_MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 60000n };
const [A0, , A2] = TERMS_MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `r${n}`, key: b32(0x58 + n), worldSecret: b32(0) });

test('#1489 r7-attest-1 (kanban #2753): one GET at the deadline persists VOID on the seat the hand-on had not reached yet, and #2423\'s hand-on is then evidence only - the seats split FINAL / VOID', { timeout: 170000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, TERMS_MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  // SEAT b RESTARTING: every POST /outcome to it fails while `down` (the hand-on of seat a included)
  const realFetch = globalThis.fetch;
  let down = true;
  globalThis.fetch = (u, o = {}) => {
    if (down && String(u).includes(`:${w.b.port}/outcome`) && String((o && o.method) || 'GET').toUpperCase() === 'POST') return Promise.reject(new Error('seat b is restarting'));
    return realFetch(u, o);
  };
  try {
    const played = [];
    for (const [i, pick] of [0, 1].entries()) played.push(await lockAndPlay(w, player(i), { noMarks: true, pick }));
    await closeRound(w, { window: false });
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const bytes = encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) });
    const post = (d) => realFetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: bytes }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 120)}`);
    // the attestor daemon reaches seat a a second before the deadline; its hand-on to b does not land (b restarting)
    skipTo(deadlineMs - 1000);
    const atA = await post(w.a);
    // half a second past the deadline: the LOSER (pick 1) - or any stranger - reads seat b once
    skipTo(deadlineMs + 500);
    const read = await (await realFetch(`http://127.0.0.1:${w.b.port}/outcome?round=${toHex(w.rid)}`)).json();
    // seat b is back: seat a's hand-on duty posts again (every 2 s), and the daemon's own retry reaches b too
    down = false;
    await wait(5000);
    const atB = await post(w.b);
    // one objection window later
    skipTo(deadlineMs + 600000 + 1000);
    const stateOf = async (d) => { const o = await (await realFetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`)).json(); return o.market || o.state; };
    const states = [await stateOf(w.a), await stateOf(w.b)];
    console.log('  #1489 r7-attest-1:', JSON.stringify({ atA, readAtB: read.market || read.state, atB, states }));
    assert.match(atA, /^20[01]/, 'seat a took the attestation before the deadline');
    assert.equal(states[0], states[1], `one GET at the deadline split the market: seat a ${states[0]}, seat b ${states[1]}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
