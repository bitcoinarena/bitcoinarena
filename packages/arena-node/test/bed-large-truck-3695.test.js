// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN HONEST LARGER-TRUCK BED IS TAKEN (kanban #3695, bypass audit wf_12229180-099 finding 1). The load checks (#1488) bound the room
// by the stock bed, 2 x 3.0 m = 393,216 units. Next Block sells the larger truck (core f0cc7b7b and later, frozen/f0cc7b7b/items.js
// LARGE_TRUCK): 2 x 3.9 m = 511,180 units, and the app's CargoBay packs to that length (LargeTruckView). An entry that plays with the
// larger truck and fills more than the stock bed - six parcels, 491,520 units, 96 % of its bed - is refused at the batch door
// and in the objection checker's inputsLoadRefusal, though the core plays it as an ordinary fill.
// The ruling (#3707): the bound follows the entry's truck, from the truck table the game's registration declares; only the unlocks the
// entry carries and owns count; a registration without the table keeps 393216 for everyone; seats, objection checker and arbiter agree.
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
import { ONE } from '../../nextblock/frozen/f0cc7b7b/fixed.js';
import { roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
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
import { PARCEL_ROOMS, BED_ROOM_UNITS, bedRoomOf } from '../src/load-checks.js';
import { coreForRound } from '../src/arbiter.js';
import { hostedPlugins } from '../src/plugins.js';
import { inputsLoadRefusal } from '../src/objection-check.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = testDevKey('items dev 3695');
const { signature: _s, ...BODY } = NEXTBLOCK.manifest;
const MANIFEST = signManifest({ ...BODY, gameDevPubkey: DEV.pubkey,
  items: [{ id: 'large-truck', name: 'Large truck', priceSat: 500n, unlock: fromHex(LARGE_TRUCK_ITEM_UNLOCK) }], requiredProtocolVersion: ITEMS_VERSION }, DEV);
const LARGE_ROOM = 2 * LARGE_TRUCK.bedLength;                                                    // 511180
// THE GAME VERSION THAT DECLARES THE TRUCK TABLE (ruling #3707), and the same version without it (every game version before the table)
const TABLE = { bedRoom: BED_ROOM_UNITS, byUnlock: { [LARGE_TRUCK_ITEM_UNLOCK]: LARGE_ROOM } };
const WITH_TABLE = { ...NEXTBLOCK, manifest: MANIFEST, gameId: gameIdOf(MANIFEST), trucks: TABLE, requiresNode: ['truck-table'] };
const NO_TABLE = { ...NEXTBLOCK, manifest: MANIFEST, gameId: gameIdOf(MANIFEST) };
const peers = Array.from({ length: 6 }, () => schnorr.getPublicKey(ed25519.utils.randomSecretKey()));
const PLAYER = b32(5);
const OWNER_SECRET = b32(0x33), OWNER = schnorr.getPublicKey(OWNER_SECRET);
const BOUGHT = b32(0xd1);

const contract = (gameId) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: TRUCK_CORE_HASH,
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
const OVER = [0, 20000, 100, LARGE_ROOM + 1];
const HELD = [0, 0, 0, 0, 0];

/** A seat hosting `game`, one entry (with the larger truck when `truck`, bought when `owned`), and its first batch carrying `load`. */
function seatTakes(game, { truck = true, owned = true, load = LOAD } = {}) {
  const round = new Round(openStore(), () => 1234, { plugins: [game, NEXTBLOCK] });
  const c = contract(game.gameId);
  const rid = round.open(c);
  assumeAssigned(round, rid, [...peers, round.identity.pubkey]);
  round.db.exec(ITEM_PURCHASES_SQL);
  if (owned) round.db.prepare('INSERT INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(toHex(BOUGHT), toHex(OWNER), toHex(DEV.pubkey), 'nextblock', 'large-truck', toHex(BOUGHT).split('').reverse().join(''), Buffer.alloc(1), Buffer.alloc(64), 1);
  const ownerSig = schnorr.sign(entryItemDigest({ roundId: rid, playerPubkey: PLAYER, purchaseId: BOUGHT }), OWNER_SECRET);
  const e = entry(rid, ed25519.getPublicKey(ed25519.utils.randomSecretKey()), truck ? [{ itemId: 'large-truck', purchaseId: BOUGHT, ownerSig }] : null);
  let eid;
  try { eid = round.enter(e); } catch (err) { return { entered: err.message }; }
  const b = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: 10 }, () => HELD), liquidations: [], loads: [load] };
  let why = null;
  try { round.batch(encodeInputBatch(b)); } catch (err) { why = err.message; }
  // the arbiter's core for the same round (arbiter.js coreForRound, what checkObjectionBundle is handed) and its objection-side answer
  const core = coreForRound(c, roundIdOf(c), hostedPlugins([game, NEXTBLOCK]));
  const form = { ticks: Array.from({ length: 10 }, (_, tick) => ({ tick, words: HELD })), loads: [load] };
  const arbiterBed = bedRoomOf(e, { unlocks: core.items, trucks: core.trucks });
  return { why, seatBed: round.bedRoomOf(round.get(rid), round.entry(eid)), arbiterBed, objection: inputsLoadRefusal(form, arbiterBed), stored: why ? null : round.transcript(rid, eid).loads.map((l) => l[3]) };
}

test('the honest larger bed: six parcels the larger truck holds, more room than the stock bed; the table\'s room is the core\'s C denominator', () => {
  assert.equal(LARGE_TRUCK.bedLength, 255590);
  assert.ok(ROOM > BED_ROOM_UNITS, `${ROOM} is above the stock bed ${BED_ROOM_UNITS}`);
  assert.ok(ROOM <= LARGE_ROOM, `${ROOM} fits the larger bed ${LARGE_ROOM}`);
  assert.ok(fill(ROOM, LARGE_TRUCK.bedLength) < ONE, 'the core reads it as a bed not yet full');
  assert.equal(fill(LARGE_ROOM, LARGE_TRUCK.bedLength), ONE, 'the table\'s capacity is the room the core reads as a full larger bed');
  assert.ok(fill(LARGE_ROOM - 2, LARGE_TRUCK.bedLength) < ONE);
});

test('#3695 (1): the larger truck\'s 491520 is taken at the batch door and by the objection checker, and the arbiter agrees', () => {
  const r = seatTakes(WITH_TABLE);
  console.log('#3695 (1)', JSON.stringify(r));
  assert.equal(r.why, null, `the batch door refuses an honest larger-truck bed: ${r.why}`);
  assert.deepEqual(r.stored, [ROOM]);
  assert.equal(r.seatBed, LARGE_ROOM);
  assert.equal(r.arbiterBed, LARGE_ROOM);
  assert.equal(r.objection, null, `the objection checker refuses an honest larger-truck bed: ${r.objection}`);
});

test('#3695 (2): the same 491520 without the unlock is refused, at the door and by the arbiter', () => {
  const r = seatTakes(WITH_TABLE, { truck: false });
  console.log('#3695 (2)', JSON.stringify(r));
  assert.match(String(r.why), /a bed is 0 \.\. 393216/);
  assert.equal(r.seatBed, BED_ROOM_UNITS); assert.equal(r.arbiterBed, BED_ROOM_UNITS);
  assert.match(String(r.objection), /a bed is 0 \.\. 393216/);
});

test('#3695 (3): 511181 on the larger truck is refused, at the door and by the arbiter', () => {
  const r = seatTakes(WITH_TABLE, { load: OVER });
  console.log('#3695 (3)', JSON.stringify(r));
  assert.match(String(r.why), /bed is 0 \.\. 511180/);
  assert.match(String(r.objection), /bed is 0 \.\. 511180/);
});

test('#3695 (4): a game version without the truck table keeps 393216, the larger truck included', () => {
  const r = seatTakes(NO_TABLE);
  console.log('#3695 (4)', JSON.stringify(r));
  assert.match(String(r.why), /a bed is 0 \.\. 393216/);
  assert.equal(r.seatBed, BED_ROOM_UNITS); assert.equal(r.arbiterBed, BED_ROOM_UNITS);
  assert.match(String(r.objection), /a bed is 0 \.\. 393216/);
});

test('#3695 (5): an unlock the entry does not own does not count - not entered unbought, not read from the inputs, not an unknown item', () => {
  const r = seatTakes(WITH_TABLE, { owned: false });
  assert.match(String(r.entered), /not one this seat keeps for this game/, 'an entry naming the larger truck it never bought is not entered');
  // the inputs of an objection naming the unlock count for nothing: the bed is the entry's
  const core = coreForRound(contract(WITH_TABLE.gameId), b32(1), hostedPlugins([WITH_TABLE, NEXTBLOCK]));
  assert.equal(bedRoomOf({ items: [] }, { unlocks: core.items, trucks: core.trucks }), BED_ROOM_UNITS);
  assert.equal(bedRoomOf({ items: [{ itemId: 'gold-truck' }] }, { unlocks: core.items, trucks: core.trucks }), BED_ROOM_UNITS, 'an unknown item selects nothing');
  assert.equal(bedRoomOf({ items: [{ itemId: 'large-truck' }] }, { unlocks: core.items, trucks: core.trucks }), LARGE_ROOM);
  const form = { ticks: [{ tick: 0, words: HELD }], loads: [LOAD], items: [LARGE_TRUCK_ITEM_UNLOCK] };
  assert.match(String(inputsLoadRefusal(form)), /a bed is 0 \.\. 393216/);
});

test('#3695 (6): a node that does not read a field a game version needs does not host it; a table that does not stand is refused', () => {
  const left = [];
  hostedPlugins([{ ...WITH_TABLE, requiresNode: ['truck-table', 'something-later'] }, NEXTBLOCK], { log: (l) => left.push(l) });
  assert.match(left.join('\n'), /needs a node that reads something-later/);
  const bad = [];
  hostedPlugins([{ ...WITH_TABLE, trucks: { bedRoom: BED_ROOM_UNITS, byUnlock: { [LARGE_TRUCK_ITEM_UNLOCK]: 4 * BED_ROOM_UNITS } } }, NEXTBLOCK], { log: (l) => bad.push(l) });
  assert.match(bad.join('\n'), /truck table that does not stand/);
});
