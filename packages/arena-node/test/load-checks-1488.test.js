// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT TAKES ONLY A LOAD AN HONEST BED COULD HAVE DECLARED (kanban #1488, feedback #011 by Hexbox Tools).
//
// A load [tick, fee, btc, room] sets the heat (fee, BTC) and the cargo factor C (room) the score is multiplied by, and the
// seat stored whatever was sent. Hexbox's two attacks: (1) a full bed with no fee and no BTC - C = 1 at heat 0; (2) drive
// empty and declare an over-full bed one tick before the gate. Both are refused at the door now, and an honest page's
// loads - several while the bay is open, one at ROLL OUT, the throttle after it - are taken as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { roomFor, fill, BED_ROOM } from '../../nextblock/src/rules/cargo.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { HOSTED } from './plugins/hosted.js';
import { PARCEL_ROOMS, BED_ROOM_UNITS, BTC_MOST_HUND, fewestParcels, loadValueRefusal } from '../src/load-checks.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

const HELD = [0, 0, 0, 0, 0];                 // the truck in the bay: controls locked
const DRIVE = [65536, 3000, 0, 0, 0];         // full throttle

/** A seat and one entry, and a way to publish the next batch: `words(t)` per tick, `loads` beside them. */
function seat() {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const eid = r.enter(entryFor(rid));
  let previousHash = GENESIS, next = 0;
  const send = (n, words, loads = []) => {
    const b = { roundId: rid, entryId: eid, previousHash, firstTick: next,
      ticks: Array.from({ length: n }, (_, k) => words(next + k)), liquidations: [], loads };
    const took = r.batch(encodeInputBatch(b));
    previousHash = batchId(b); next += n;
    return took;
  };
  const stored = () => r.transcript(rid, eid).loads;
  return { send, stored };
}

test('the parcel sizes and the bed are the core\'s own (the app\'s rules/cargo.js)', () => {
  assert.deepEqual([100, 300, 1000, 2000].map(roomFor), PARCEL_ROOMS);
  assert.deepEqual([249, 599, 1499, 1e6].map(roomFor), PARCEL_ROOMS, 'the four classes, at their upper edges');
  assert.equal(fill(BED_ROOM_UNITS), 65536, 'the bed the seat bounds is the one the core reads as full');
  assert.equal(BED_ROOM_UNITS, BED_ROOM << 16);
  assert.equal(fewestParcels(0), 0);
  assert.equal(fewestParcels(4 * 68812), 4);
  assert.equal(fewestParcels(275250), -1, '0.7 of the bed is no bed of parcels');
  assert.equal(fewestParcels(BED_ROOM_UNITS), -1);
  let made = 0, most = 0;
  for (let r = 0; r <= BED_ROOM_UNITS; r++) if (fewestParcels(r) >= 0) { made++; most = r; }
  console.log(`  rooms a bed of parcels makes: ${made}, the fullest ${most} of ${BED_ROOM_UNITS}`);
});

test('an honest page: an empty bed when the bay opens, each change, ROLL OUT, then the drive - every load taken', () => {
  const { send, stored } = seat();
  // ticks 0..199 held in the bay: the empty bed at 4, a parcel at 60, a full bed at 120 (testnet4 574FF7F4's values)
  assert.equal(send(200, () => HELD, [[4, 0, 0, 0], [60, 3214, 62, 88474], [120, 16334, 141, 369618]]), 200);
  // ROLL OUT at 200 declares the bed once more and unlocks: throttle from 201
  assert.equal(send(100, (t) => (t > 200 ? DRIVE : HELD), [[200, 16334, 141, 369618]]), 100);
  assert.equal(send(100, () => DRIVE), 100);
  assert.deepEqual(stored(), [[4, 0, 0, 0], [60, 3214, 62, 88474], [120, 16334, 141, 369618], [200, 16334, 141, 369618]]);
  // the practice word (the fifth) is not driving: a page in practice mode sets it from tick 0
  const p = seat();
  assert.equal(p.send(50, () => [0, 0, 0, 0, 65536], [[10, 2162, 1, 252308]]), 50);
});

test('Hexbox 1: a full bed with no fee and no BTC is refused, and nothing of the batch is stored', () => {
  const { send, stored } = seat();
  assert.throws(() => send(10, () => HELD, [[0, 0, 0, 393214]]), /393214 room units - 7 parcels at the fewest - and pays 0 sats/);
  assert.throws(() => send(10, () => HELD, [[0, 0, 0, BED_ROOM_UNITS]]), /which no bed of parcels fills/);
  assert.throws(() => send(10, () => HELD, [[0, 0, 0]]), /carries no room/, 'no room scores 0.7 of a bed: refused too');
  assert.throws(() => send(10, () => HELD, [[0, 0, 0, 275250]]), /which no bed of parcels fills/, 'the old fixture bed');
  assert.deepEqual(stored(), []);
  // and the run goes on with an honest batch at the same tick
  assert.equal(send(10, () => HELD, [[0, 9, 0, 393214]]), 10);
});

test('Hexbox 2: drive empty, then declare a bed before the gate - refused', () => {
  const { send, stored } = seat();
  assert.equal(send(100, (t) => (t >= 1 ? DRIVE : HELD), [[0, 0, 0, 0]]), 100, 'an empty bed at ROLL OUT');
  assert.equal(send(200, () => DRIVE), 200);
  // one tick before the gate: an over-full bed, and a full one paid like a real one - both after the truck was driven
  assert.throws(() => send(100, () => DRIVE, [[398, 0, 0, 450000]]), /fills 450000 room units: a bed is 0 \.\. 393216/);
  assert.throws(() => send(100, () => DRIVE, [[398, 16334, 141, 369618]]), /comes after the truck was driven: a bed is declared before ROLL OUT/);
  // in the same batch as the driving, and in a batch of no ticks at the next one
  const s2 = seat();
  assert.throws(() => s2.send(100, (t) => (t >= 10 ? DRIVE : HELD), [[50, 16334, 141, 369618]]), /driven at tick 10/);
  assert.equal(s2.send(100, (t) => (t >= 10 ? DRIVE : HELD)), 100);
  assert.throws(() => s2.send(0, () => DRIVE, [[100, 16334, 141, 369618]]), /comes after the truck was driven/);
  assert.deepEqual(stored(), [[0, 0, 0, 0]]);
});

test('the rest of the shape: negative, absurd and misplaced loads (two at one tick the batch codec already refuses)', () => {
  const { send } = seat();
  const refused = [
    [[[0, -5, 0, 36044]], /a fee is not negative/],
    [[[0, 100, -1, 36044]], /carries -1 hundredths/],
    [[[0, 100, BTC_MOST_HUND + 1, 36044]], /a truck carries 0 \.\. 2000/],
    [[[0, 100, 0, -36044]], /a bed is 0 \.\./],
    [[[0, 5, 0, 0]], /an empty bed carrying 5 sats/],
    [[[0, 0, 3, 0]], /an empty bed carrying 0 sats and 3/],
    [[[0, 1, 0, 2 * 36044]], /2 parcels at the fewest - and pays 1 sats/],
    [[[10, 9, 0, 36044]], /not at a tick this batch carries \(0 \.\. 9\)/],
  ];
  for (const [loads, why] of refused) assert.throws(() => send(10, () => HELD, loads), why, JSON.stringify(loads));
  assert.equal(send(10, () => HELD, [[9, 2, BTC_MOST_HUND, 2 * 36044]]), 10, 'the edges themselves are taken');
});

test('loads real pages declared on a testnet4 seat (node-1.db, 2026-10-06 .. 11-11) all pass the value rules', () => {
  // [fee, btc, room] of every distinct page load with a room, read -readonly from the seat's `loads` table 2026-11-11
  const real = [[0, 0, 0], [2162, 1, 252308], [4993, 1, 252308], [1336, 44, 267382], [5492, 270, 267382], [19983, 1, 252308],
    [14164, 4, 252308], [6515, 104, 267382], [33871, 3, 252308], [2109, 2, 252308], [12566, 838, 267382], [1724, 1604, 252308],
    [2645, 1, 252308], [3734, 126, 252308], [11412, 7, 249032], [19775, 17, 264110], [6633, 322, 243136], [3214, 62, 88474],
    [4114, 154, 139592], [5034, 176, 208404], [14034, 186, 244448], [15155, 49, 267382], [16055, 141, 318500], [16334, 141, 369618]];
  for (const [fee, btc, room] of real) assert.equal(loadValueRefusal([0, fee, btc, room]), null, `${fee} ${btc} ${room}`);
  console.log(`  ${real.length} distinct real page loads, every one taken`);
});
