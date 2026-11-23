// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round, noteAttestedLiquidationGames } from '../src/round.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { liquidationEventId } from '../../arena-protocol/src/price-sample.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { LIQ_MAX } from '../../nextblock/src/state.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = (nodes, stakeMsat = 100000n) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});


// kanban #2694 (follow-up of #2655, option 2): a staked run of a Next Block version that takes committee-attested liquidations
// (v9, known-games attestedLiquidations) plays a strike the committee signed and refuses one it did not; v8 keeps the #2655 refusal.
const { schnorr } = await import('@noble/curves/secp256k1.js');
const sks = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x40 + n));
const seats = sks.map((sk) => schnorr.getPublicKey(sk));
const att = (rid, tick, size, n = 5) => [tick, 4, size, sks.slice(0, n).map((sk, i) => [seats[i], schnorr.sign(liquidationEventId({ roundId: rid, tick, size }), sk, new Uint8Array(32))])];
const w = [65536, 0, 0, 0, 0];
const ticks = Array.from({ length: 30 }, () => w);
const SIZE = 655360;   // ten million USD, Q16.16
const play = (r, rid, eid, extra) => r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks, liquidations: [], ...extra }));

test('#2694 v8 staked run: an attested liquidation is still refused (#2655 unchanged)', () => {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract(seats)); const eid = r.enter(entryFor(rid));
  assert.throws(() => play(r, rid, eid, { liquidations: [[7, SIZE]], attests: [att(rid, 7, SIZE)] }), /no player-declared liquidations/);
  assert.deepEqual(r.transcript(rid, eid).liquidations, []);
});

test('#2694 v9 staked run: an attested strike is stored, a bare or short-signed one is refused', () => {
  noteAttestedLiquidationGames([Buffer.from(NEXTBLOCK_GAME_ID).toString('hex')]);
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract(seats)); const eid = r.enter(entryFor(rid));
  // a bare LIQ_MAX strike beside an attested one
  assert.throws(() => play(r, rid, eid, { liquidations: [[7, SIZE], [11, LIQ_MAX]], attests: [att(rid, 7, SIZE)] }), /tick 11 without the committee's attestation/);
  // four of seven signatures
  assert.throws(() => play(r, rid, eid, { liquidations: [[7, SIZE]], attests: [att(rid, 7, SIZE, 4)] }), /4 of the committee signed it/);
  // the attested size, played larger
  assert.throws(() => play(r, rid, eid, { liquidations: [[7, LIQ_MAX]], attests: [att(rid, 7, SIZE)] }), /not the attested size/);
  assert.deepEqual(r.transcript(rid, eid).liquidations, []);
  // the honest batch: two attested strikes and a zero-size liquidation
  play(r, rid, eid, { liquidations: [[3, 0], [7, SIZE], [21, 2 * SIZE]], attests: [att(rid, 7, SIZE), att(rid, 21, 2 * SIZE)] });
  assert.deepEqual(r.transcript(rid, eid).liquidations, [[3, 0], [7, SIZE], [21, 2 * SIZE]]);
});

test('#2694 v9 free run: a bare liquidation is taken as before, an attestation it carries must still stand', () => {
  noteAttestedLiquidationGames([Buffer.from(NEXTBLOCK_GAME_ID).toString('hex')]);
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract(seats, 0n)); const eid = r.enter({ ...entryFor(rid), stakeMsat: 0n, feeMsat: entryFeeMsat(0n) });
  assert.throws(() => play(r, rid, eid, { liquidations: [[7, SIZE]], attests: [att(rid, 7, SIZE, 4)] }), /4 of the committee signed it/);
  play(r, rid, eid, { liquidations: [[7, SIZE], [11, LIQ_MAX]] });
  assert.deepEqual(r.transcript(rid, eid).liquidations, [[7, SIZE], [11, LIQ_MAX]]);
});
