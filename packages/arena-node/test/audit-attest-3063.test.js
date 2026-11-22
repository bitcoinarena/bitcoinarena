// kanban #3063: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT 2026-11-19 r4, attest round 3, finding 1: POST /outcome starts one hand-on duty per distinct BYTE ENCODING of an attestation
// (server.js handOutcomeOn keys a duty by sha256(raw)), and every non-relayed post of a held attestation before deadline + grace starts the
// duty again. One attestation's signatures can be re-ordered and repeated (attestationStands allows up to n entries, a repeat counts once),
// so a stranger who copies the public attestation (GET /outcome serves its bytes) posts K encodings of it to an honest seat, and that seat
// runs K duties - each posting the attestation to every settlement peer that has not answered 200/201, again every 2 s until the market's
// deadline + 30 s. One settlement seat that answers its POST /outcome with 409 keeps every duty alive: the honest seat's hand-on traffic
// grows with K, not with the number of attestations.
// The safe behaviour: re-posting an attestation that is held already (another encoding of the same body) starts no second hand-on duty,
// so the hand-on posts the seat makes do not grow with the number of encodings a stranger sends.
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
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 600000n, sourceRule: 'median of three test feeds' };
const MARKET = testAttestedGame({ name: 'btc-close-handon', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('audit attest r4-3-1: other encodings of one held attestation start no more hand-on duties at an honest seat', async () => {
  const w = await lockRound({ n: 7, stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    for (const [i, pick] of [0, 1].entries()) await lockAndPlay(w, player(i + 70), { noMarks: true, pick });
    await closeRound(w, { window: false });
    // after the resolution time, well before the deadline (close + 60 s + 600 s)
    skipTo(Number(w.c.entryCloseMs) + 61000);
    // ONE SETTLEMENT SEAT (seat 1, role b) refuses every POST /outcome with 409; every hand-on post to it is counted
    const victimPort = String(w.nodes[0].port), refuserPort = String(w.nodes[1].port);
    let relayedToRefuser = 0;
    globalThis.fetch = async (url, o = {}) => {
      const u = new URL(String(url));
      if (o.method === 'POST' && u.pathname === '/outcome' && u.port === refuserPort) {
        const h = o.headers || {};
        if (h['x-arena-relayed'] === '1') relayedToRefuser++;
        return new Response('not now', { status: 409 });
      }
      return realFetch(url, o);
    };
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const [s0, s1, s2] = MARKET.attestors.map((a) => attestorSign(a, body));
    const post = async (sigs) => {
      const r = await realFetch(`http://127.0.0.1:${victimPort}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: sigs }) });
      return `${r.status}`;
    };
    // the honest attestation, handed in once: every seat takes it and hands it on (one duty each, the refuser retried every 2 s)
    const first = await post([s0, s1]);
    assert.ok(first === '201' || first === '200', `the honest attestation was not held: ${first}`);
    await wait(1500);
    relayedToRefuser = 0;
    await wait(5000);
    const before = relayedToRefuser;
    // THE STRANGER: the same attestation in other encodings - the signatures re-ordered and repeated (each stands: a repeat counts once)
    const sigsOf = { a: s0, b: s1, c: s2 };
    const encodings = [];
    for (const x of 'abc') for (const y of 'abc') { if (x !== y) encodings.push([x, y]); for (const z of 'abc') if (new Set([x, y, z]).size >= 2) encodings.push([x, y, z]); }
    const said = [];
    for (const e of encodings) said.push(await post(e.map((k) => sigsOf[k])));
    const held = said.filter((s) => s === '200' || s === '201').length;
    await wait(1500);
    relayedToRefuser = 0;
    await wait(5000);
    const after = relayedToRefuser;
    globalThis.fetch = realFetch;
    console.log('  r4-3-1:', JSON.stringify({ encodings: encodings.length, held, handOnPostsToRefuser5s: { before, after } }));
    assert.ok(held >= 20, `the re-encoded attestations were not taken (${held} of ${encodings.length}): ${said.slice(0, 5).join(',')}`);
    // one attestation, the same duties: the hand-on traffic does not grow with the encodings a stranger posted
    assert.ok(after <= before + 4, `${encodings.length} encodings of one held attestation multiplied the hand-on posts to the refusing seat: ${before} -> ${after} in 5 s`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
