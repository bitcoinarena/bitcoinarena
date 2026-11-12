// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET ON A GAME SETTLED AT A SEAT (feature 6, §0A.7d; protocol 2026.0.6): the source round's signed result is
// HELD where an attestation is held (store.js game_outcomes) and every reader of an attested round's outcome reads it, so the
// market settles exactly as an attested market - pari-mutuel, final after the round's objection window - with the source's
// RoundResult and its committee's signatures as the evidence. FLAT (mapped to 0xff) is VOID at once, not at the deadline. A
// forged or 4-of-7 result is never held. The seat's own sweep resolves a market it holds once, and looks at each round of its
// store once. A seat without the source round fetches its contract from other seats and takes it only if it is the round the
// market names (a series round only as a series it holds derives it), then counts the committee it draws itself.
// Harness: a real store (openStore + Round) with the market and source rounds written in as a seat keeps them, a fake roster
// draw, fake seats behind an injected fetch; the settlement plan from LockSettlement over the same store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets, gameMarketSweep, heldOutcomes, marketVoidOf, gameEvidenceOf, NO_RESULT_ID } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId, decodeRoundResult } from '../../arena-protocol/src/round-result.js';
import { pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { seriesRound } from '../../arena-protocol/src/series.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';
import { opts } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk), url: `http://seat${n}.example` }; });
const strangers = [1, 2, 3, 4, 5].map((n) => { const sk = b32(n + 90); return { sk, pk: schnorr.getPublicKey(sk) }; });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts', outcomes: ['BULLS', 'BEARS'],
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins this Tick Tock round?', resolveAfterCloseMs: 600000n,
    deadlineAfterResolveMs: 3600000n, sourceRule: 'the source round\'s RoundResult (§13), signed by 5 of its 7 seats' },
  gameSource: { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] },
  requiredProtocolVersion: GAME_MARKET_VERSION });

const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: seats.map((s) => s.pk) };
const SOURCE_ID = roundId(SOURCE);
const STAKE = 1_000_000n;
const market = (over = {}) => ({ ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, stakeMsat: STAKE, ...over });
// THE SOURCE ROUND HAS ENDED by S + 200 s (9000 ticks); the market's deadline is entry close + 600 s + 1 h
const AFTER_END = Number(S) + 200000;

const resultOf = (openCents, closeCents, sid = SOURCE_ID) => ({ roundId: sid, openCents, closeCents });
const signedBy = (openCents, closeCents, keys, sid = SOURCE_ID) => {
  const id = roundResultId(resultOf(openCents, closeCents, sid));
  return { openCents, closeCents, sigs: keys.map((s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) })) };
};
const BULLS = [8297000, 8298000], BEARS = [8298000, 8297000], FLAT = [8297000, 8297000];

/** A seat's store holding `rounds` (written as POST /round keeps them), on a clock the test moves. */
function seatStore(rounds) {
  const clock = { ms: AFTER_END };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  for (const c of rounds) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  return { round, clock };
}
// THE ROSTER'S DRAW FOR THE SOURCE: the seven seats, each advertising where it answers - never the source contract's `nodes`.
// `asked` records each draw; a draw for a source this seat does not hold must be made on the fetched contract (`posted`)
function drawFor(asked = []) {
  return (id, role, o) => {
    asked.push({ id: toHex(id), role, posted: !!(o && o.posted) });
    if (role !== 'settlement' || toHex(id) !== toHex((o && o.posted && roundId(o.posted)) || SOURCE_ID)) return { ok: false, why: 'not drawn' };
    return { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) };
  };
}
// real Responses: a peer's answer is read as a capped stream (kanban #1829), as in game-market-settle
const json = (x) => new Response(JSON.stringify(x), { status: 200 });
const bytes = (b) => new Response(b, { status: 200 });
const missing = { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
/** Fake seats: `answers` maps a seat's URL to what it answers GET /round-result with (a result signed by that seat), `contracts` to GET /round. */
function seatsAnswering({ results = {}, contracts = {} } = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}`;
    if (u.pathname === '/round-result' && results[base]) return json(results[base]);
    if (u.pathname === '/round' && contracts[base]) return bytes(contracts[base]);
    return missing;
  };
}
const resultBy = (seat, [openCents, closeCents], sid = SOURCE_ID) => {
  const id = roundResultId(resultOf(openCents, closeCents, sid));
  return { ok: true, round: toHex(sid), openCents, closeCents, key: toHex(seat.pk), signature: toHex(schnorr.sign(id, seat.sk)) };
};

// FOUR PICKS: two on BULLS (1 and 3 units), two on BEARS (2 and 2) - net stakes as their locks hold them, no fee
const PICKS = [[0, 1n], [1, 2n], [0, 3n], [1, 2n]];
function withEntries(round, rid) {
  const entries = PICKS.map(([pick, units], i) => {
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    return { entryId: b32(0x30 + i), entry: { roundId: rid, playerPubkey, stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } };
  });
  const CLAIM = new Uint8Array(33).fill(2);
  const view = Object.assign(Object.create(round), {
    entriesOf: () => entries,
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: (eid) => { const e = entries.find((x) => toHex(x.entryId) === toHex(eid)); return { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: e.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(e.entry.playerPubkey), expiration: 1000 }) }; },
    feeLock: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });
  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  return { view, entries, settlement };
}


// wf1489 round 3 (attest-1): ONE COMMITTEE SEAT OF THE SOURCE ROUND VOIDS EVERY MARKET ON IT. collect() keeps each seat's GET /round-result
// answer whose signature is any string, and roundResultStands -> priceAttestationStands parses a committee key's signature with
// s.signature.match(/../g).map(...) outside any try: a 1-character (or empty) signature under the seat's own key throws a TypeError, out of
// gameMarketResolution ("never throws"), hold and resolveOnce. The sweep catches it and retries the same answers every 30 s until the
// market's deadline - then VOID, every stake back, though six honest seats signed BULLS. SAFE: the junk signature counts for nothing.
test('wf1489-r3-attest-1: one source-committee seat answering a 1-character signature does not stop the seat holding the six honest signatures of the result', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([SOURCE, M]);
  const results = Object.fromEntries(seats.map((s, i) => [s.url, i === 6 ? { ...resultBy(s, BULLS), signature: 'a' } : resultBy(s, BULLS)]));
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms, fetcher: seatsAnswering({ results }) });
  const got = await markets.resolveOnce(rid).catch((e) => ({ done: false, threw: true, why: `${e.name}: ${e.message}` }));
  console.log(`  resolveOnce with one junk-signing seat: ${JSON.stringify({ done: got.done, threw: !!got.threw, why: got.why })}`);
  assert.equal(got.done, true, `the six honest signatures were not held: ${got.why}`);
  assert.equal(round.gameOutcomes(rid).length, 1);
});
