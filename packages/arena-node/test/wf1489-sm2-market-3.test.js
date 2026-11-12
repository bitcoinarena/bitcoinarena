// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE MACHINE AUDIT (kanban #1489, round 2, market): THE DEADLINE EDGE SPLITS THE SEATS. SM-4 (MARKET_STATE): OPEN -> ATTESTED on the first
// standing attestation RECEIVED before the deadline D on the seat's own clock, OPEN -> VOID at D otherwise. POST /outcome keeps an attestation
// at the seat it reached and hands it to nobody (only a drawn seat's own combined one is handed on), and a seat never asks the others what they
// hold before it turns VOID. An attestor daemon posts the seats one after another (8 s timeout each): one seat takes the attestation a second
// before D, the next one a second after it. The first goes ATTESTED -> FINAL and plans the settlement; the second is VOID for good and opens the
// return door. Two seats of one round decide differently: with a threshold of both kinds out of reach, nothing is claimed and nothing comes back
// until the locks expire - the winner never gets his winnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const STAKE = 1_000_000n;
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const TERMS_MARKET = testAttestedGame({ name: 'btc-close-terms-sm2c', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
const ROUND = { gameId: TERMS_MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 60000n };
const [A0, , A2] = TERMS_MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `q${n}`, key: b32(0x48 + n), worldSecret: b32(0) });

test('#1489 sm2-market-3: an attestation reaching one seat just before the deadline and the other just after leaves the two seats deciding the same market differently', { timeout: 170000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, TERMS_MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [];
    for (const [i, pick] of [0, 1].entries()) played.push(await lockAndPlay(w, player(i), { noMarks: true, pick }));
    await closeRound(w, { window: false });
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const bytes = encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) });
    const post = (d) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: bytes }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 100)}`);
    // THE ATTESTOR DAEMON'S PASS: seat a a second before the deadline, seat b (its answer took the daemon's 8 s timeout) a second after it
    skipTo(deadlineMs - 1000);
    const atA = await post(w.a);
    skipTo(deadlineMs + 1000);
    const atB = await post(w.b);
    // ONE OBJECTION WINDOW LATER: a is FINAL on its own record, b VOID on its own
    skipTo(deadlineMs + 600000 + 1000);
    const stateOf = async (d) => { const o = await (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`)).json(); return o.market || o.state; };
    const states = [await stateOf(w.a), await stateOf(w.b)];
    const settled = await w.a.settlements.settle(w.rid);
    const forfeit = (d, e) => fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}`).then((r) => r.status);
    const doors = { a: await Promise.all(played.map((e) => forfeit(w.a, e))), b: await Promise.all(played.map((e) => forfeit(w.b, e))) };
    console.log('  #1489 sm2-market-3:', JSON.stringify({ atA, atB, states, settle: [settled.state, String(settled.why || '').slice(0, 140)], doors }));
    assert.match(atA, /^20[01]/, 'seat a took the attestation before the deadline');
    assert.equal(states[0], states[1], `the two seats of one market decide it differently: seat a ${states[0]}, seat b ${states[1]}`);
  } finally { await w.close(); }
});
