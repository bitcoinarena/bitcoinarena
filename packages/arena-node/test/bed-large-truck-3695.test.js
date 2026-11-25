// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN HONEST LARGER-TRUCK BED IS TAKEN (kanban #3695, bypass audit wf_12229180-099 finding 1). The load checks (#1488) bound the room
// by the stock bed, 2 x 3.0 m = 393,216 units. Next Block sells the larger truck (core f0cc7b7b and later, frozen/f0cc7b7b/items.js
// LARGE_TRUCK): 2 x 3.9 m = 511,180 units, and the app's CargoBay packs to that length (LargeTruckView). An entry that plays with the
// larger truck and fills more than the stock bed - six parcels, 491,520 units, 96 % of its bed - is refused at the batch door
// and in the objection checker's inputsLoadRefusal, though the core plays it as an ordinary fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { ITEM_PURCHASES_SQL } from '../src/item-purchase-seat.js';
import { assumeAssigned } from './assignment.js';
import { testDevKey } from './plugins/sign.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { NEXTBLOCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { LARGE_TRUCK_ITEM_UNLOCK } from '../../nextblock/plugin/truck-cores.js';
import { LARGE_TRUCK } from '../../nextblock/frozen/f0cc7b7b/items.js';
import { fill } from '../../nextblock/frozen/f0cc7b7b/rules/cargo.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { entryItemDigest } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { PARCEL_ROOMS, BED_ROOM_UNITS } from '../src/load-checks.js';
import { inputsLoadRefusal } from '../src/objection-check.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = testDevKey('items dev 3695');
const { signature: _s, ...BODY } = NEXTBLOCK.manifest;
const MANIFEST = signManifest({ ...BODY, gameDevPubkey: DEV.pubkey,
  items: [{ id: 'large-truck', name: 'Large truck', priceSat: 500n, unlock: fromHex(LARGE_TRUCK_ITEM_UNLOCK) }], requiredProtocolVersion: ITEMS_VERSION }, DEV);
const GAME = { ...NEXTBLOCK, manifest: MANIFEST, gameId: gameIdOf(MANIFEST) };
const peers = Array.from({ length: 6 }, () => schnorr.getPublicKey(ed25519.utils.randomSecretKey()));
const PLAYER = b32(5);
const OWNER_SECRET = b32(0x33), OWNER = schnorr.getPublicKey(OWNER_SECRET);
const BOUGHT = b32(0xd1);

const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: GAME.gameId, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, protocolVersion: ITEMS_VERSION, nodes: [],
});
const entry = (rid, sessionPubkey, items) => ({ roundId: rid, playerPubkey: PLAYER, sessionPubkey, stakeCommitment: b32(7), stakeMsat: 100000n,
  feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32), ...(items ? { items } : {}) });

// six parcels, three to a column: 1.35 + 1.35 + 1.05 = 3.75 m of the larger truck's 3.9 m (the stock column is 3.0 m)
const ROOM = 2 * (2 * PARCEL_ROOMS[3] + PARCEL_ROOMS[2]);
const LOAD = [0, 20000, 100, ROOM];
const HELD = [0, 0, 0, 0, 0];

test('the honest larger bed: six parcels the larger truck holds, more room than the stock bed, a fill the core plays', () => {
  assert.equal(LARGE_TRUCK.bedLength, 255590);
  assert.ok(ROOM > BED_ROOM_UNITS, `${ROOM} is above the stock bed ${BED_ROOM_UNITS}`);
  assert.ok(ROOM <= 2 * LARGE_TRUCK.bedLength, `${ROOM} fits the larger bed ${2 * LARGE_TRUCK.bedLength}`);
  assert.ok(fill(ROOM, LARGE_TRUCK.bedLength) < 65536, 'the core reads it as a bed not yet full');
});

test('a seat takes that load from an entry playing with the larger truck (the batch door)', () => {
  const round = new Round(openStore(), () => 1234, { plugins: [GAME, NEXTBLOCK] });
  const rid = round.open(contract());
  assumeAssigned(round, rid, [...peers, round.identity.pubkey]);
  round.db.exec(ITEM_PURCHASES_SQL);
  round.db.prepare('INSERT INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(toHex(BOUGHT), toHex(OWNER), toHex(DEV.pubkey), 'nextblock', 'large-truck', toHex(BOUGHT).split('').reverse().join(''), Buffer.alloc(1), Buffer.alloc(64), 1);
  const ownerSig = schnorr.sign(entryItemDigest({ roundId: rid, playerPubkey: PLAYER, purchaseId: BOUGHT }), OWNER_SECRET);
  const session = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const eid = round.enter(entry(rid, session, [{ itemId: 'large-truck', purchaseId: BOUGHT, ownerSig }]));
  const b = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: 10 }, () => HELD), liquidations: [], loads: [LOAD] };
  let why = null;
  try { round.batch(encodeInputBatch(b)); } catch (e) { why = e.message; }
  console.log('#3695 batch door:', why);
  assert.equal(why, null, `the batch door refuses an honest larger-truck bed: ${why}`);
  assert.deepEqual(round.transcript(rid, eid).loads.map((l) => l[3]), [ROOM]);
});

test('the objection checker takes the same load from the larger truck\'s inputs (inputsLoadRefusal)', () => {
  const form = { ticks: Array.from({ length: 10 }, (_, tick) => ({ tick, words: HELD })), loads: [LOAD], items: [LARGE_TRUCK_ITEM_UNLOCK] };
  const why = inputsLoadRefusal(form, { bedLength: LARGE_TRUCK.bedLength });
  console.log('#3695 inputsLoadRefusal:', why);
  assert.equal(why, null, `the objection checker refuses an honest larger-truck bed: ${why}`);
});
