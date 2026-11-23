// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (attestations / markets on games): ONE PUBLIC SOURCE RESULT, PADDED, BUYS ~113 BIP-340 CHECKS PER POST.
// POST /game-outcome?round=<market round> is open to anybody (server.js): { openCents, closeCents, sigs } with sigs.slice(0, 64), and
// markets.hold() resolves it every time - no "held already" short-cut before any signature is checked. resolveWith ->
// gameMarketResolution -> roundResultStands -> priceAttestationStands checks up to n tries per committee key (49 for 7), and then
// standingSigs() checks EVERY entry again whose key has not verified yet - junk placed before a key's real signature is verified
// each time (seen.add only on a good one). So a stranger who copies the source committee's real result (GET /round-result is public)
// and pads it with junk signatures under the committee's keys makes every POST cost the seat ~113 BIP-340 verifies in JS on its one
// thread - for a 7-seat committee whose result needs at most 7 - and can repeat it without limit while the market is open to a result.
// SAFE: one hold of a result checks at most one signature per committee key per pass (here: at most 2 x 7 verifies a POST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets } from '../src/game-market.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId } from '../../arena-protocol/src/round-result.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk), url: `http://seat${n}.example` }; });
let calls = 0;
const verify = (sig, msg, pk) => { calls++; try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts-r2a1', outcomes: ['BULLS', 'BEARS'],
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
const M = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, stakeMsat: 1_000_000n };
const AFTER_END = Number(S) + 200000;
const committeeFor = (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID)
  ? { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) } : { ok: false, why: 'not drawn' });

test('wf1489-r2-attest-1: a padded copy of the public source result does not cost a seat ~113 signature checks per POST /game-outcome', async () => {
  const round = new Round(openStore(':memory:'), () => AFTER_END, { plugins: [MARKET.registration] });
  for (const c of [SOURCE, M]) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor, verify, now: () => AFTER_END, fetcher: async () => ({ ok: false, status: 404 }) });
  const [openCents, closeCents] = [8297000, 8298000];
  const id = roundResultId({ roundId: SOURCE_ID, openCents, closeCents });
  const real = (s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) });
  const junk = (s, i) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, b32(200 - (i % 50)))) });   // a valid-looking signature by another key
  // THE ATTACKER'S BODY: five seats' real signatures (as GET /round-result serves them), each after six junk ones under its key, and the
  // other two keys' junk filling the list to the door's 64
  const sigs = [];
  let n = 0;
  for (const s of seats.slice(0, 5)) { for (let j = 0; j < 6; j++) sigs.push(junk(s, n++)); sigs.push(real(s)); }
  while (sigs.length < 64) sigs.push(junk(seats[5 + (sigs.length % 2)], n++));
  // the first hold takes it (the honest path: an outcome held)
  const first = await markets.hold(roundId(M), { openCents, closeCents, sigs: sigs.slice(0, 64) });
  assert.equal(first.held, true, first.why);
  // EVERY LATER POST of the same bytes: measured
  const per = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) {
    calls = 0;
    const got = await markets.hold(roundId(M), { openCents, closeCents, sigs: sigs.slice(0, 64) });
    assert.equal(got.held, true);
    per.push(calls);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log('  MEASURED:', JSON.stringify({ sigsInBody: sigs.length, verifiesPerPost: per[0], msPerPost: Math.round(ms), postsToFillOneSecond: Math.round(1000 / ms) }));
  assert.ok(per[0] <= 2 * seats.length, `one POST /game-outcome of a held result ran ${per[0]} BIP-340 checks (${Math.round(ms)} ms on the seat's one thread) for a committee of ${seats.length}`);
});
