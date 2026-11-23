// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (attack, one seat of the source's committee): A MARKET ON A GAME IS NEVER RESOLVED - ONE EMPTY SIGNATURE STRING. The seat's own
// sweep (game-market.js resolveOnce -> collect) groups the committee's GET /round-result answers by open/close and takes any
// `signature` that is a string. price-sample.js priceAttestationStands (via round-result.js roundResultStands) turns a string signature
// into bytes with `s.signature.match(/../g).map(...)`: for "" match() is null and it THROWS - its own contract says "a signature that does
// not verify counts nothing - it never refuses the others". One committee seat answering the honest open/close with signature "" makes
// every resolveOnce throw; the sweep retries every 30 s until the market's deadline and the market goes VOID with 6 good signatures held.
// Adapted to 1.9 by #2536 (kanban #1504): 1.9 reads a seat's GET /round-result through bytesUpTo (#1829, capped), which reads the body
// stream; the card's stand-in answer had only json(), so no answer was read at all ("none of the 0 answer(s)"). Answered as a fetch does.
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
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts-wf1489', outcomes: ['BULLS', 'BEARS'],
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
const BULLS = [8297000, 8298000];
const resultBy = (seat, [openCents, closeCents]) => {
  const id = roundResultId({ roundId: SOURCE_ID, openCents, closeCents });
  return { ok: true, round: toHex(SOURCE_ID), openCents, closeCents, key: toHex(seat.pk), signature: toHex(schnorr.sign(id, seat.sk)) };
};

test('#1504 (1.9) wf1489-3: one committee seat answering the honest result with an empty signature string does not stop the market from resolving', async () => {
  const clock = { ms: Number(S) + 200000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  for (const c of [SOURCE, M]) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  const committeeFor = (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID)
    ? { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) } : { ok: false, why: 'not drawn' });
  // SIX HONEST SEATS SIGN BULLS; SEAT 7 ANSWERS THE SAME RESULT WITH signature ""
  const results = Object.fromEntries(seats.map((s, i) => [s.url, i === 6 ? { ...resultBy(s, BULLS), signature: '' } : resultBy(s, BULLS)]));
  const fetcher = async (url) => {
    const u = new URL(url);
    const r = results[`${u.protocol}//${u.host}`];
    return u.pathname === '/round-result' && r ? new Response(JSON.stringify(r), { status: 200 }) : new Response('{}', { status: 404 });
  };
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor, verify, now: () => clock.ms, fetcher });
  let got;
  try { got = await markets.resolveOnce(roundId(M)); } catch (e) { got = { threw: e.message }; }
  const held = round.gameOutcomes(roundId(M));
  console.log('  wf1489-3:', JSON.stringify({ got: got.threw ? got : { done: got.done, why: got.why }, held: held.length }));
  assert.equal(got.threw, undefined, `resolveOnce threw: ${got.threw}`);
  assert.equal(got.done, true, got.why);
  assert.equal(held.length, 1);
  assert.equal(held[0].outcome, 0);
});
