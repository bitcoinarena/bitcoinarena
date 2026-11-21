// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3 attest 1: ONE SETTLEMENT PEER'S UNSIGNED GET /outcome ANSWER BACKDATES A LATE ATTESTATION (kanban #2423's hand-on).
// POST /outcome of an attestation that is late by the market's deadline alone, inside ATTEST_HANDON_GRACE_MS, asks the round's
// settlement peers (outcomeTakenByPeer) whether one of them took it in time - and ONE peer's plain JSON { state: 'ATTESTED', outcome,
// finalAtMs } is enough: the attestation is held, filed at the time that one peer stated, and the market that had no outcome by its
// deadline (VOID, every stake back) turns ATTESTED and then FINAL. The safe behaviour: a single peer's word is not proof that the
// outcome was taken in time - the late attestation stays refused (409) and the round is not ATTESTED here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const STAKE = 1_000_000n;
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const TERMS_MARKET = testAttestedGame({ name: 'btc-close-terms', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: TERMS_MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = TERMS_MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });

test('#1489 r3-attest-1: one settlement peer\'s unsigned GET /outcome answer does not make a seat take an attestation handed in after the market\'s deadline', async () => {
  // kanban #2680: a committee of 7 (as live): one lying seat is within what it tolerates; a 2-seat committee tolerates none
  const w = await lockRound({ n: 7, stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, TERMS_MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    for (const [i, pick] of [0, 1].entries()) await lockAndPlay(w, player(i + 60), { noMarks: true, pick });
    await closeRound(w, { window: false });
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    // NO OUTCOME BY THE DEADLINE: the attestation (valid, 2 of 3) is handed in 1 s after it, inside the 30 s hand-on grace
    skipTo(deadlineMs + 1000);
    // THE ONE LYING PEER (seat b, a settlement peer of seat a): its GET /outcome says it took outcome 0 five seconds before the deadline
    const W = Number(w.c.objectionWindowMs);
    let lies = 0;
    globalThis.fetch = async (url, o = {}) => {
      const u = new URL(String(url));
      if ((!o.method || o.method === 'GET') && u.pathname === '/outcome' && u.port === String(w.nodes[1].port)) {
        lies++;
        return new Response(JSON.stringify({ round: toHex(w.rid), state: 'ATTESTED', market: 'ATTESTED', outcome: 0, finalAtMs: String(deadlineMs - 5000 + W) }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, o);
    };
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const r = await realFetch(`http://127.0.0.1:${w.nodes[0].port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) }) });
    const said = `${r.status} ${(await r.text()).slice(0, 200)}`;
    globalThis.fetch = realFetch;
    const o = await (await realFetch(`http://127.0.0.1:${w.nodes[0].port}/outcome?round=${toHex(w.rid)}`)).json();
    console.log('  r3-attest-1:', JSON.stringify({ lies, post: said, stateAtA: o.state, market: o.market, outcome: o.outcome }));
    assert.equal(r.status, 409, `a late attestation was held on one peer's unsigned word: ${said}`);
    assert.notEqual(o.state, 'ATTESTED', 'the market with no outcome by its deadline turned ATTESTED on one peer\'s word');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
