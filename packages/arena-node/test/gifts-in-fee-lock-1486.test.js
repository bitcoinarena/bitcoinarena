// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S HALF OF KANBAN #1486 (ruled 2026-11-11: "Er sollte keine fees entgegen nehmen wenn die order nicht angenommen wird"). On a
// protocol-27 game round the developers' and the reserves' parts ride in the entry's fee lock:
//   - the door takes an entry whose fee is the whole 10 % and whose donation is 0, and refuses today's shape (4 % + 6 % as outputs);
//   - a round below 27 keeps today's door: its 4 % fee, its 6 % donation and its reserve output;
//   - an ENTRY_VOID entry's fee lock is forfeited back at once beside its stake; a qualifier's is not (it is claimed), nor a round below 27's;
//   - the settlement names the round's donation target and its federation's reserve key (giftsFor), and claims nothing without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Forfeit } from '../src/forfeit.js';
import { LockSettlement } from '../src/settlement.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { GIFTS_IN_FEE_LOCK_VERSION, MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { RESERVE_LATER_PK } from '../../arena-protocol/src/lock-settlement.js';
import { roundSplit } from '../../arena-protocol/src/reserves.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key33 = (n) => Uint8Array.of(0x02, ...new Uint8Array(32).fill(n));
const NOW = 1788700000000;
const STAKE = 100000n;
const roundOf = (protocolVersion) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID,
  simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(8), b32(9)], protocolVersion });
const split = roundSplit(STAKE);
let n = 0;
const entryOn = (rid, more = {}) => ({
  roundId: rid, playerPubkey: b32(0x40 + (n % 100)), sessionPubkey: b32(0xa0 + (n++ % 90)), stakeCommitment: b32(7), stakeMsat: STAKE, feeMsat: 10000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32), ...more });
const TODAY = { feeMsat: split.nodesMsat, donationMsat: split.protocolDevsMsat + split.gameDevsMsat + split.reservesMsat,
  donationOutpoints: [{ txid: b32(0x0d), outIdx: 2n }, { txid: b32(0x0d), outIdx: 3n }], reserveOutpoint: { txid: b32(0x0d), outIdx: 4n } };
let clock = NOW;
const door = (protocolVersion) => { const r = new Round(openStore(':memory:'), () => clock, { plugins: HOSTED }); clock = NOW; const rid = r.open(roundOf(protocolVersion)); clock = NOW + 1000; return { r, rid }; };
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

test('the door on protocol 27: a 10 % fee and no donation is taken; today\'s 4 % + 6 % with outputs, or a 4 % fee alone, is refused by name', () => {
  const { r, rid } = door(GIFTS_IN_FEE_LOCK_VERSION);
  const took = refusal(() => r.enter(entryOn(rid)));
  assert.equal(took, null, took);
  assert.match(refusal(() => r.enter(entryOn(rid, TODAY))), /in the fee lock: that entry names a donation of 6000 msat/);
  assert.match(refusal(() => r.enter(entryOn(rid, { feeMsat: 4000n }))), /10000 msat, not 4000/);
  assert.match(refusal(() => r.enter(entryOn(rid, { reserveOutpoint: { txid: b32(0x0d), outIdx: 4n } }))), /no donation or reserve output/);
});

test('the door below 27 is today\'s: the 4 % fee with the 6 % donation and its reserve output is taken, the protocol-27 shape refused', () => {
  const { r, rid } = door(20);
  const took = refusal(() => r.enter(entryOn(rid, TODAY)));
  assert.equal(took, null, took);
  assert.match(refusal(() => r.enter(entryOn(rid))), /4000|developers' 4 %/);
});

// A SEAT THAT HOLDS ONE ENTRY'S STAKE AND FEE LOCKS (the lock-fate-1184 fixture)
const CLAIM_SK = b32(0x33);
const CLAIM_PK = Uint8Array.from([2, ...schnorr.getPublicKey(CLAIM_SK)]);
const RID = b32(0x71);
const PLAYER = b32(0x12);
const STAKE_AT = `${toHex(b32(0x52))}:0`, FEE_AT = `${toHex(b32(0x52))}:1`;
const fields = (msat) => ({ paymentImage: { kind: 'hash', bytes: '' }, amountMsat: String(msat), claimPk: toHex(CLAIM_PK), refundPk: '02' + '11'.repeat(32), expiration: 1000 });
const encoded = (protocolVersion) => encodeRoundContract({ ...roundOf(protocolVersion), gameVerifySlots: 7, settlementSlots: 7, nodes: [] });
function seat(protocolVersion) {
  const round = new Round(openStore(':memory:'));
  const contract = encoded(protocolVersion);
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract } : null);
  const voids = new Set();
  round.entryVoid = (eid) => (voids.has(toHex(eid)) ? { learned: 'own', why: 'outage' } : null);
  round.stakeLock = (eid) => (toHex(eid) === toHex(PLAYER) ? { outpoint: STAKE_AT, contractId: 'cd'.repeat(32), fields: fields(90000n) } : null);
  round.feeLock = (eid) => (toHex(eid) === toHex(PLAYER) ? { outpoint: FEE_AT, contractId: 'cd'.repeat(32), fields: fields(10000n) } : null);
  const dkg = { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) };
  const forfeit = new Forfeit(round, { dkg, port: { contractId: async () => 'cd'.repeat(32) }, curve, random: (k) => crypto.getRandomValues(new Uint8Array(k)) });
  return { round, forfeit, voids };
}

// ON 2.0, 27 IS ALSO THE ARENA LOCK'S VERSION (arena-lock.js NAMED_CLAIM_VERSION): this fixture's locks are stock contracts, so its rounds sit
// below regtest's named-claim point by the harness switch (as a testnet4 round of 27 does, whose point is none)
const stockLocks = (fn) => async () => {
  const was = { net: process.env.ARENA_DONATION_NETWORK, h: process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT };
  process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';
  try { await fn(); } finally {
    process.env.ARENA_DONATION_NETWORK = was.net ?? ''; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = was.h ?? '';
  }
};

test('ENTRY_VOID on protocol 27: the fee lock - the developers\' and the reserves\' parts with the nodes\' - is forfeited back at once with the stake', stockLocks(async () => {
  const { forfeit, voids } = seat(GIFTS_IN_FEE_LOCK_VERSION);
  voids.add(toHex(PLAYER));
  const stake = await forfeit.message(RID, PLAYER, 'stake');
  assert.equal(stake.ok, true, stake.why);
  const fee = await forfeit.message(RID, PLAYER, 'fee');
  assert.equal(fee.ok, true, fee.why);
  assert.equal(fee.outpoint, FEE_AT);
  // the forfeit of the fee lock is the committee's signature over its contract, taken and kept like the stake's
  const kept = await forfeit.take(RID, PLAYER, schnorr.sign(fee.message, CLAIM_SK), 'fee');
  assert.equal(kept.ok, true, kept.why);
}));

test('no early fee return for an entry that is not ENTRY_VOID, nor below protocol 27 (its fee lock expires back as before)', stockLocks(async () => {
  const live = seat(GIFTS_IN_FEE_LOCK_VERSION);
  const counted = await live.forfeit.message(RID, PLAYER, 'fee');
  assert.equal(counted.ok, false, 'a counted entry\'s fee lock is claimed at settlement');
  assert.match(counted.why, /^a fee lock comes back at once only for a cancelled order or a refunded market/);
  assert.match(counted.why, /not ENTRY_VOID/);
  const old = seat(20);
  old.voids.add(toHex(PLAYER));
  assert.equal((await old.forfeit.message(RID, PLAYER, 'stake')).ok, true, 'the stake comes back as before');
  const oldFee = await old.forfeit.message(RID, PLAYER, 'fee');
  assert.equal(oldFee.ok, false, 'below 27 the fee lock holds only the nodes\' fee and is left to expire, as before');
}));

test('the settlement names the round\'s donation target and its federation\'s reserve key for a protocol-27 round, and claims nothing without them', async () => {
  const TARGET = { network: [{ recipientPk: key33(0xa1), shareBps: 10000, label: 'dev' }], game: [{ recipientPk: key33(0xa2), shareBps: 10000, label: 'game' }] };
  const RK = key33(0xe5);
  const asked = [];
  const make = (over = {}) => new LockSettlement(new Round(openStore(':memory:')), { curve, port: {}, dkg: {}, stakeSecrets: {},
    donationTargetFor: () => ({ ok: true, target: TARGET }), reserveKeyFor: async (fid) => { asked.push(fid); return RK; }, ...over });
  const c27 = roundOf(GIFTS_IN_FEE_LOCK_VERSION);
  const g = await make().giftsFor(c27, { feeLocks: 2 });
  assert.equal(g.ok, true, g.why);
  assert.equal(g.gifts.recipients, TARGET);
  assert.equal(toHex(g.gifts.reserveKey), toHex(RK));
  assert.deepEqual(asked, [toHex(TEST_FEDERATION_ID)]);
  assert.equal(g.gifts.split.reserves, 200);
  // below 27, or with no fee lock to claim: nothing of it
  assert.equal((await make().giftsFor(roundOf(20), { feeLocks: 2 })).gifts, null);
  assert.equal((await make().giftsFor(c27, { feeLocks: 0 })).gifts, null);
  // a round that takes any federation: planned to the placeholder, each federation's own key put in at the split
  const any = await make().giftsFor({ ...c27, federationId: new Uint8Array(32), protocolVersion: GIFTS_IN_FEE_LOCK_VERSION }, { feeLocks: 1 });
  assert.equal(toHex(any.gifts.reserveKey), toHex(RESERVE_LATER_PK));
  // no target, no reserve key: refused by name - no lock is claimed, the fee locks expire back to their players
  const noTarget = await make({ donationTargetFor: () => ({ ok: false, why: 'no set' }) }).giftsFor(c27, { feeLocks: 1 });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.why, /developers' part, and no set/);
  const noKey = await make({ reserveKeyFor: async () => null }).giftsFor(c27, { feeLocks: 1 });
  assert.equal(noKey.ok, false);
  assert.match(noKey.why, /no reserve key is known/);
});
