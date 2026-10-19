// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET RUNS IN ITS WINDOW ONLY (2026-10-11: "Der prediction market läuft immer z.B. zwischen 19:45 und 20:00. Man
// darf davor und danach nicht am Markt teilnehmen und mit Wetten. Das ist die allgemeine Regel für prediction markets"): a
// market on its game's period takes a pick from entry_close - period to entry_close and at no other time, is seated 120 s
// before that window opens, and counts as live from its window's start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { marketWindowOf } from '../../arena-protocol/src/attested.js';
import { seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { gameLive } from '../src/game-live.js';
import { pluginForRound, hostedPlugins } from '../src/plugins.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_PERIOD_MS } from './plugins/updown/index.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const P = UPDOWN_PERIOD_MS;
const CLOSE = 2n * P;                                    // the window runs P .. 2P (e.g. 19:45 .. 20:00)
const PLUGINS = [NEXTBLOCK, UPDOWN.registration];
const market = () => ({
  networkId: b32(0x4e), configHash: b32(0), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: UPDOWN.registration.gameId, simCoreHash: b32(0),
  startTimeMs: CLOSE, entryCloseMs: CLOSE, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 0,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});
const pick = (rid, k) => ({
  roundId: rid, playerPubkey: b32(5 + k), sessionPubkey: b32(0x60 + k), stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32), pick: 0,
});
const why = (f) => { try { f(); return 'taken'; } catch (e) { return e.message; } };
const windowFor = (hosted) => (c) => { const f = pluginForRound(c, hosted); return f.ok && f.attested ? marketWindowOf(c, f.plugin.manifest).window : null; };

test('a market takes a pick only inside its window: refused before it opens and from its close on', () => {
  let now = 1000;
  const r = new Round(openStore(), () => now, { plugins: PLUGINS });
  const rid = r.open(market());
  now = Number(P) - 1;                                   // 19:44:59.999 - the committee exists, the window not yet
  const before = why(() => r.enter(pick(rid, 0)));
  assert.match(before, /^that market opens at 1970-01-01T00:15:00\.000Z and runs to 1970-01-01T00:30:00\.000Z: it takes no pick before its window$/);
  now = Number(P);                                       // 19:45:00 - open
  const inside = why(() => r.enter(pick(rid, 1)));
  assert.equal(inside, 'taken');
  now = Number(CLOSE);                                   // 20:00:00 - closed
  assert.match(why(() => r.enter(pick(rid, 2))), /entries closed at 1970-01-01T00:30:00\.000Z: an attested round takes no pick after its entry close/);
  console.log('  WINDOW:', JSON.stringify({ before: before.slice(0, 120), inside: inside.slice(0, 120) }));
});

test('a market is seated 120 s before its window opens, and live from the window\'s start to its end', () => {
  const c = market();
  const w = windowFor(hostedPlugins(PLUGINS))(c);
  assert.deepEqual(w, { startMs: P, endMs: CLOSE, periodMs: P });
  assert.equal(seatingCloseMs(c, w), P - 120000n);       // 19:43
  assert.equal(seatingCloseMs(c), CLOSE - 120000n);      // without the window: the round's start - 120 s, as before
  let now = 1000;
  const r = new Round(openStore(), () => now, { plugins: PLUGINS });
  r.open(market());
  const game = toHex(UPDOWN.registration.gameId);
  const at = (ms) => { now = ms; return (gameLive(r, { nowMs: () => now, windowOf: windowFor(hostedPlugins(PLUGINS)) })()[game] || { rounds: 0 }).rounds; };
  assert.deepEqual([at(Number(P) - 1), at(Number(P) + 1), at(Number(CLOSE) - 1)], [0, 1, 1]);
});
