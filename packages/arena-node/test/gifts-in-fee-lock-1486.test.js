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
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';  // kanban #1675: fixture keys are curve points

const b32 = (n) => new Uint8Array(32).fill(n);
const key33 = (n) => pointKey(0x02, n);   // kanban #1675: a donation recipient key is a curve point
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

test('ENTRY_VOID on protocol 27: the fee lock - the developers\' and the reserves\' parts with the nodes\' - is forfeited back at once with the stake', async () => {
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
});

test('no early fee return for an entry that is not ENTRY_VOID, nor below protocol 27 (its fee lock expires back as before)', async () => {
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
});

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

// A FEE PROPOSAL CHANGES THE SPLIT (Daniel 2026-11-12, "Ja" to (3)): a protocol-27 round's door, gates and settlement all read the split in force
// at its census height - the fee set GET /fees?height= serves and the page reads - so every seat takes, settles and returns it alike.
test('a fee proposal changes the split: a v27 round created after activation is entered, settled and refunded alike at every seat', async () => {
  const { feesAt, FEES_TODAY, roundSplitBps } = await import('../../arena-protocol/src/fee-proposal.js');
  const { lockSettlement, feeLockPays } = await import('../../arena-protocol/src/lock-settlement.js');
  const { roundMintsFees } = await import('../src/stake-lock-signer-node.js');
  const { giftsFeeBps, giftsEntryExpected } = await import('../../arena-protocol/src/reserves.js');
  const { DELIVERED, FAILED, ENTRY_VOID } = await import('../../arena-protocol/src/payout.js');
  const ACT = 900100;
  // the proposal: nodes 3.5 %, developers 4.5 %, reserves 1.5 % - 9.5 % in all, from block ACT
  const NEW = { ...FEES_TODAY, roundNodeBps: 350, roundDonationBps: 450, roundReserveBps: 150 };
  const feesFor = (c) => feesAt({ height: Number(c.censusHeight), accepted: [{ accepted: true, activationHeight: ACT, fees: NEW }], base: FEES_TODAY });
  const after = { ...roundOf(GIFTS_IN_FEE_LOCK_VERSION), censusHeight: ACT + 5 };
  const before = { ...roundOf(GIFTS_IN_FEE_LOCK_VERSION), censusHeight: ACT - 1 };
  const split = roundSplitBps(feesFor(after));
  assert.deepEqual([split.nodes, split.protocolDevs + split.gameDevs, split.reserves, giftsFeeBps(split)], [350, 450, 150, 950]);

  // THE DOOR, AT THREE SEATS: 9,500 msat after activation, 10,000 before; the other refused by name at each
  const seats = [0, 1, 2].map(() => { const r = new Round(openStore(':memory:'), () => clock, { plugins: HOSTED }); r.feesFor = feesFor; return r; });
  clock = NOW;
  const ids = seats.map((r) => [r.open(after), r.open(before)]);
  clock = NOW + 1000;
  for (const [i, r] of seats.entries()) {
    const [ra, rb] = ids[i];
    assert.equal(refusal(() => r.enter(entryOn(ra, { feeMsat: 9500n }))), null, `seat ${i} takes 9,500 after activation`);
    assert.match(refusal(() => r.enter(entryOn(ra, { feeMsat: 10000n }))), /9500 msat, not 10000/);
    assert.equal(refusal(() => r.enter(entryOn(rb, { feeMsat: 10000n }))), null, `seat ${i} takes 10,000 before activation`);
    assert.match(refusal(() => r.enter(entryOn(rb, { feeMsat: 9500n }))), /10000 msat, not 9500/);
  }
  // a round below 27 ignores the proposal's split at the door: its 4 % fee and 6 % donation, as before
  { const r = seats[0]; clock = NOW; const old = r.open({ ...roundOf(20), censusHeight: ACT + 5 }); clock = NOW + 1000;
    assert.equal(refusal(() => r.enter(entryOn(old, TODAY))), null); }

  // THE GATES: the seats' /stake-lock and door gate and the page's size the same 9,500 msat lock
  const fees = { ppm: 1000n, baseMsat: 0n };
  const seatGate = await roundMintsFees({ contract: after, port: { fees: async () => fees }, feeBps: giftsFeeBps(split), split });
  const pageGate = feeLockPays({ contract: after, fees, feeBps: giftsFeeBps(split), split });
  assert.equal(seatGate.mints, true, seatGate.why);
  assert.deepEqual([pageGate.pays, pageGate.lockMsat], [true, 9500n]);
  assert.equal(giftsEntryExpected({ entry: { stakeMsat: STAKE, feeMsat: 9500n, donationMsat: 0n }, split }).ok, true);

  // THE SETTLEMENT AT EVERY SEAT: the same gifts, the same plan - nodes 3.5 %, developers 4.5 %, reserves 1.5 % of each counted entry;
  // the ENTRY_VOID entry's fee lock claimed by none
  const TARGET = { network: [{ recipientPk: key33(0xa1), shareBps: 10000, label: 'dev' }], game: [{ recipientPk: key33(0xa2), shareBps: 10000, label: 'game' }] };
  const RK = key33(0xe5);
  const NODES = [b32(8), b32(9)];
  const e = (k, outcome, score) => ({ entryId: b32(0x60 + k), pubkey: b32(0x70 + k), stakeMsat: STAKE, feeMsat: 9500n, donationMsat: 0n, outcome, score });
  const entries = [e(1, DELIVERED, 3), e(2, FAILED, 0), e(3, ENTRY_VOID, 0)];
  const locks = new Map(entries.map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x90 + i), outIdx: 0n }, amountMsat: 90500n, refundPk: key33(0x10 + i) }]));
  const feeLocks = new Map(entries.map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x90 + i), outIdx: 1n }, amountMsat: 9500n, preimage: b32(0xb0 + i) }]));
  const plans = [];
  for (const r of seats) {
    const ls = new LockSettlement(r, { curve, port: {}, dkg: {}, stakeSecrets: {}, feesFor,
      donationTargetFor: () => ({ ok: true, target: TARGET }), reserveKeyFor: async () => RK });
    const gf = await ls.giftsFor(after, { feeLocks: feeLocks.size });
    assert.equal(gf.ok, true, gf.why);
    assert.deepEqual(gf.gifts.split, split);
    const plan = lockSettlement({ roundId: b32(0x71), entries, minScore: 1, locks, feeLocks, fees: { ppm: 0n, baseMsat: 0n }, contract: { ...after, nodes: NODES },
      signerNodes: { gameVerify: NODES, settlement: NODES }, ...ls.roundFees(after), gifts: gf.gifts });
    assert.equal(plan.ok, true, plan.why);
    plans.push(JSON.stringify({ c: plan.claims, p: plan.payouts }, (k, v) => (typeof v === 'bigint' ? `${v}` : v instanceof Uint8Array ? toHex(v) : v)));
    const sum = (kind) => plan.payouts.filter((p) => p.kind === kind).reduce((t, p) => t + p.msat, 0n);
    assert.deepEqual([sum('signer node'), sum('donation key'), sum('reserve')], [7000n, 9000n, 3000n]);
    assert.equal(plan.feeClaims.some((c) => toHex(c.outpoint.txid) === toHex(b32(0x92))), false, 'the ENTRY_VOID entry\'s fee lock is not claimed');
  }
  assert.equal(new Set(plans).size, 1, 'every seat builds the one plan');

  // THE REFUND: the ENTRY_VOID entry's 9,500 msat fee lock forfeited back at once with its stake, at a seat reading the same round
  const s = seat(GIFTS_IN_FEE_LOCK_VERSION);
  s.round.feeLock = (eid) => (toHex(eid) === toHex(PLAYER) ? { outpoint: FEE_AT, contractId: 'cd'.repeat(32), fields: fields(9500n) } : null);
  s.voids.add(toHex(PLAYER));
  assert.equal((await s.forfeit.message(RID, PLAYER, 'stake')).ok, true);
  const back = await s.forfeit.message(RID, PLAYER, 'fee');
  assert.equal(back.ok, true, back.why);
});
