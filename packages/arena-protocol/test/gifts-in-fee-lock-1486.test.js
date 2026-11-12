// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO DEVELOPER OR RESERVE MONEY FOR AN ENTRY THAT IS NOT ACCEPTED (kanban #1486, ruled 2026-11-11: "Er sollte keine fees entgegen nehmen
// wenn die order nicht angenommen wird"; feedback #010: 100 sat staked, 94 back, the 6 sat donation and reserve outputs lost). From
// protocol 27 a game entry's fee lock holds the nodes' 4 %, the developers' 4 % and the reserves' 2 %, and the settlement pays the
// developers and the reserves only out of the fee locks of COUNTED entries: a refused, void or refunded entry's fee lock is never
// claimed and comes back with its stake. Below 27 every byte and every payout is as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSettlement, lateLockSettlement, feeLockPays, RESERVE_LATER_PK } from '../src/lock-settlement.js';
import { splitByFederation } from '../src/federation-settlement.js';
import { giftsInFeeLock, giftsFeeBps, giftsEntryExpected, entryFeeBpsForRound, entryPaysReserves, entryGiftsInFee, roundSplit,
  ROUND_SPLIT_BPS, RESERVES_NODE_FEE_BPS } from '../src/reserves.js';
import { feeMatchesEntry, entryFeeMsat } from '../src/fee.js';
import { splitDonation } from '../src/donation.js';
import { DELIVERED, FAILED, VOID, ENTRY_VOID, FORFEIT } from '../src/payout.js';
import { GIFTS_IN_FEE_LOCK_VERSION, SUPPORTED_PROTOCOL_VERSIONS, speaksVersion } from '../src/constants.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const key33 = (p, n) => Uint8Array.of(p, ...new Uint8Array(32).fill(n));
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const STAKE = 100000n;
const DEVS = [{ recipientPk: key33(0x02, 0xa1), shareBps: 6667, label: 'dev a' }, { recipientPk: key33(0x03, 0xb2), shareBps: 3333, label: 'dev b' }];
const TARGET = { network: DEVS, game: [{ recipientPk: key33(0x02, 0xc4), shareBps: 10000, label: 'game dev' }] };
const RESERVE_KEY = key33(0x02, 0xe5);
const GIFTS = { recipients: TARGET, reserveKey: RESERVE_KEY, split: ROUND_SPLIT_BPS };
const SEATS = [pk(0xa1), pk(0xa2)];
const contractOf = (protocolVersion) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: SEATS, protocolVersion,
});
const V27 = contractOf(GIFTS_IN_FEE_LOCK_VERSION);
const V20 = contractOf(20);
const split = roundSplit(STAKE);
// THE TWO RULES' ENTRIES AT 100 SAT: today's (fee 4 %, donation 6 % as outputs) and protocol 27's (fee 10 %, donation 0)
const NEW = { feeMsat: 10000n, donationMsat: 0n };
const OLD = { feeMsat: split.nodesMsat, donationMsat: split.protocolDevsMsat + split.gameDevsMsat + split.reservesMsat };
const entry = (n, outcome, score, rule = NEW) => ({ entryId: b32(0x30 + n), pubkey: pk(n), stakeMsat: STAKE, ...rule, outcome, score });
const lockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat: e.stakeMsat - e.feeMsat - e.donationMsat, refundPk: key33(0x02, n) }];
const feeLockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(n) }, amountMsat: e.feeMsat, preimage: b32(0xf0 + n) }];
const sum = (s, kind) => s.payouts.filter((p) => p.kind === kind).reduce((t, p) => t + p.msat, 0n);
const settle = (entries, over = {}) => lockSettlement({ roundId: RID, entries, minScore: 1, fees: NO_FEES, contract: V27,
  signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map(entries.map((e, i) => lockFor(e, i + 1))),
  feeLocks: new Map(entries.map((e, i) => feeLockFor(e, i + 1))), feeBps: RESERVES_NODE_FEE_BPS, gifts: GIFTS, ...over });

test('protocol 27 is spoken, and a paid game round of it takes the whole 10 % in the fee lock - nodes 4, developers 4, reserves 2 - and no donation', () => {
  assert.equal(GIFTS_IN_FEE_LOCK_VERSION, 27);
  assert.ok(speaksVersion(27) && SUPPORTED_PROTOCOL_VERSIONS.includes(20));
  assert.equal(giftsInFeeLock(V27), true);
  assert.equal(giftsInFeeLock(V20), false, 'a round below 27 keeps today\'s outputs');
  assert.equal(giftsInFeeLock({ ...V27, stakeMsat: 0n }), false, 'a free round pays nothing');
  assert.equal(giftsFeeBps(), 1000);
  assert.deepEqual([entryFeeBpsForRound(V27, null), entryFeeBpsForRound(V20, null)], [1000, 400]);
  assert.deepEqual([entryPaysReserves(V27, null), entryPaysReserves(V20, null)], [false, true], 'from 27 no reserve output at the lock');
  const market = { resultType: 2, marketTerms: { nodeFeeBps: 40, donationBps: 60 } };
  assert.equal(entryGiftsInFee(V27, market), false, 'a market keeps its own fee lock rule');
  assert.equal(entryFeeBpsForRound(V27, market), 100);
  const g = giftsEntryExpected({ entry: { stakeMsat: STAKE, ...NEW } });
  assert.deepEqual([g.ok, g.fee, g.nodesMsat, g.devsMsat, g.reservesMsat], [true, 10000n, 4000n, 4000n, 2000n]);
  assert.equal(entryFeeMsat(STAKE, giftsFeeBps()), g.fee, 'the fee is the rate of the stake, as every fee is');
  assert.equal(feeMatchesEntry({ stakeMsat: STAKE, ...NEW }, { feeBps: giftsFeeBps(), donationInFee: true }).net, 90000n, 'the same 90 % net stake as before');
  // the parts always sum to the fee, an odd stake's floors to the developers
  const odd = giftsEntryExpected({ entry: { stakeMsat: 33333n, feeMsat: 3333n, donationMsat: 0n } });
  assert.equal(odd.nodesMsat + odd.devsMsat + odd.reservesMsat, odd.fee);
  for (const [why, e, re] of [
    ['today\'s entry', { stakeMsat: STAKE, ...OLD }, /in the fee lock: that entry names a donation of 6000 msat/],
    ['a 4 % fee', { stakeMsat: STAKE, feeMsat: 4000n, donationMsat: 0n }, /10000 msat, not 4000/],
    ['a reserve output', { stakeMsat: STAKE, ...NEW, reserveOutpoint: { txid: b32(1), outIdx: 0n } }, /no donation or reserve output/],
    ['donation outputs', { stakeMsat: STAKE, ...NEW, donationOutpoints: [{ txid: b32(1), outIdx: 0n }] }, /no donation or reserve output/],
  ]) assert.match(giftsEntryExpected({ entry: e }).why, re, why);
});

test('accepted and settled: the developers\' 4 % and the reserves\' 2 % of every counted entry are paid as today - the nodes\' 4 % unchanged', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const s = settle([W, L]);
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.feeClaims.map((c) => toHex(c.pubkey)).sort(), [W, L].map((e) => toHex(e.pubkey)).sort());
  assert.equal(s.feePoolMsat, 20000n);
  // per entry exactly what a protocol-11 entry gave at its lock: 4,000 to the developers, 2,000 to the reserves; 4,000 to the nodes
  assert.deepEqual([sum(s, 'signer node'), sum(s, 'donation key'), sum(s, 'reserve')], [8000n, 8000n, 4000n]);
  const reserve = s.payouts.find((p) => p.kind === 'reserve');
  assert.equal(toHex(reserve.payoutPk), toHex(RESERVE_KEY));
  assert.equal(reserve.reserve, true);
  // the developers' 8,000 split over the round's two sets as any donation is: half the protocol devs', half the game dev's
  const want = splitDonation({ donationMsat: 8000n, recipients: TARGET }).shares.filter((x) => x.amountMsat > 0n);
  assert.deepEqual(s.payouts.filter((p) => p.kind === 'donation key').map((p) => [toHex(p.payoutPk), p.msat]).sort(),
    want.map((x) => [toHex(x.recipientPk), x.amountMsat]).sort());
  // each donation line names the entries that paid into it (the donations index lists them, as a market's)
  for (const p of s.payouts.filter((x) => x.kind === 'donation key'))
    assert.deepEqual(p.donation.parts.map((x) => [x.entryId, x.feeMsat]), [[toHex(W.entryId), 6000n], [toHex(L.entryId), 6000n]]);
  // the nodes are paid exactly what a protocol-11 round's 4 % fee locks pay them
  const today = lockSettlement({ roundId: RID, entries: [entry(1, DELIVERED, 3, OLD), entry(2, FAILED, 0, OLD)], minScore: 1, fees: NO_FEES, contract: V20,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map([lockFor(entry(1, DELIVERED, 3, OLD), 1), lockFor(entry(2, FAILED, 0, OLD), 2)]),
    feeLocks: new Map([feeLockFor(entry(1, DELIVERED, 3, OLD), 1), feeLockFor(entry(2, FAILED, 0, OLD), 2)]), feeBps: RESERVES_NODE_FEE_BPS });
  assert.equal(today.ok, true, today.why);
  assert.deepEqual(s.signerNodePayouts.filter((p) => p.kind === 'signer node').map((p) => [toHex(p.payoutPk), p.msat]).sort(),
    today.signerNodePayouts.map((p) => [toHex(p.payoutPk), p.msat]).sort());
  // the stake part is the one it was: the loser's 90,000 claimed and paid to the winner
  assert.deepEqual([s.poolMsat, sum(s, 'qualifier')], [today.poolMsat, sum(today, 'qualifier')]);
});

test('refused, void or refunded: the entry\'s fee lock - its nodes\', developers\' and reserves\' parts - is never claimed and comes back with its stake', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0), V = entry(3, VOID, 0), E = entry(4, ENTRY_VOID, 0);
  const s = settle([W, L, V, E]);
  assert.equal(s.ok, true, s.why);
  const claimed = new Set(s.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`));
  for (const [e, n] of [[V, 3], [E, 4]]) {
    const [, fl] = feeLockFor(e, n);
    assert.equal(claimed.has(`${toHex(fl.outpoint.txid)}:${fl.outpoint.outIdx}`), false, `${e.outcome}'s fee lock is not claimed: it returns whole`);
  }
  // the gifts of the counted two only - nothing of the 6,000 + 6,000 the void entries hold is paid to anybody
  assert.deepEqual([sum(s, 'donation key'), sum(s, 'reserve')], [8000n, 4000n]);
  assert.ok(s.payouts.filter((p) => p.kind === 'donation key').every((p) => p.donation.parts.length === 2));
  // a round with no counted entry (every entry refunded): no fee lock is claimed at all, so nothing is lost but the guardians' own fees
  const none = settle([entry(5, VOID, 0), entry(6, ENTRY_VOID, 0)]);
  assert.ok(none.nothing || (none.ok === false) || (none.feeClaims || []).length === 0, JSON.stringify(none.why));
  if (none.ok) assert.equal((none.feeClaims || []).length, 0);
});

test('an old-rule entry still settles: a round below 27 pays its 4 % fee locks to the nodes only, its gifts were paid at the lock', () => {
  const W = entry(1, DELIVERED, 3, OLD), L = entry(2, FAILED, 0, OLD);
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, contract: V20, signerNodes: { gameVerify: SEATS, settlement: SEATS },
    locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]), feeBps: RESERVES_NODE_FEE_BPS });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([sum(s, 'signer node'), sum(s, 'donation key'), sum(s, 'reserve')], [8000n, 0n, 0n]);
  assert.equal(s.feePoolMsat, 8000n);
  assert.equal(L.stakeMsat - L.feeMsat - L.donationMsat, 90000n, 'its lock holds the same 90 % net');
  // a protocol-27 round's fee locks read without its gifts are refused, never paid whole to the nodes
  const blind = settle([entry(1, DELIVERED, 3), entry(2, FAILED, 0)], { gifts: null });
  assert.equal(blind.ok, false);
  assert.match(blind.why, /the fee locks hold 20000/);
  // and without a reserve key or a donation target nothing is claimed: the fee locks expire back to their players
  assert.match(settle([entry(1, DELIVERED, 3), entry(2, FAILED, 0)], { gifts: { ...GIFTS, reserveKey: null } }).why, /no reserve key is known/);
  assert.match(settle([entry(1, DELIVERED, 3), entry(2, FAILED, 0)], { gifts: { ...GIFTS, recipients: null } }).why, /no donation target is known/);
});

test('a walk-away is an accepted entry: its fee lock pays the developers and the reserves as a loser\'s does', () => {
  const W = entry(1, DELIVERED, 3), F = { ...entry(2, FORFEIT, 0), atTheDoor: true };
  const s = settle([W, F]);
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([sum(s, 'donation key'), sum(s, 'reserve')], [8000n, 4000n]);
});

test('a round in any federation: each federation\'s part of the reserves goes to its own reserve key', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const plan = settle([W, L], { gifts: { ...GIFTS, reserveKey: RESERVE_LATER_PK } });
  assert.equal(plan.ok, true, plan.why);
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const fedOf = (o) => (Number(o.outIdx) % 2 ? A : B);
  const keys = { [A]: key33(0x02, 0x0a), [B]: key33(0x02, 0x0b) };
  const got = splitByFederation(plan, { roundId: RID, federationOf: fedOf, feesOf: () => NO_FEES, reserveKeyOf: (f) => keys[f] || null });
  assert.equal(got.ok, true, got.why);
  for (const st of got.settlements) {
    const r = st.payouts.filter((p) => p.reserve);
    assert.equal(r.length, 1);
    assert.equal(toHex(r[0].payoutPk), toHex(keys[st.federation]));
  }
  assert.match(splitByFederation(plan, { roundId: RID, federationOf: fedOf, feesOf: () => NO_FEES, reserveKeyOf: () => null }).why, /names no reserve key/);
});

test('a late loser\'s second settlement claims its fee lock and pays the developers and the reserves; a late VOID is not claimed', () => {
  const L = entry(2, FAILED, 0);
  const [, lock] = lockFor(L, 2);
  const [, feeLock] = feeLockFor(L, 2);
  const shares = [{ pubkey: pk(1), msat: 90000n }];
  const winnerLocks = new Map([[toHex(pk(1)), { refundPk: key33(0x02, 1) }]]);
  const s = lateLockSettlement({ roundId: RID, entryId: L.entryId, entry: L, lock, feeLock, shares, winnerLocks, fees: NO_FEES,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, contract: V27, feeBps: RESERVES_NODE_FEE_BPS, gifts: GIFTS });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([sum(s, 'signer node'), sum(s, 'donation key'), sum(s, 'reserve'), sum(s, 'qualifier')], [4000n, 4000n, 2000n, 90000n]);
  const v = lateLockSettlement({ roundId: RID, entryId: L.entryId, entry: { ...L, outcome: VOID }, lock, feeLock, shares, winnerLocks, fees: NO_FEES,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, contract: V27, feeBps: RESERVES_NODE_FEE_BPS, gifts: GIFTS });
  assert.equal(v.ok, false);
  assert.match(v.why, /not claimed/);
});

test('the fee-lock gate on protocol 27 is sized on the whole 10 % and asks only whether the nodes\' 4 % pays every sitting seat', () => {
  const fees = { ppm: 1000n, baseMsat: 0n };
  const g = feeLockPays({ contract: V27, fees, feeBps: giftsFeeBps() });
  assert.equal(g.pays, true, g.why);
  assert.equal(g.lockMsat, 10000n);
  assert.equal(g.signerNodes, 2);
  assert.equal(g.perSignerNodeNetMsat.length, 2, 'the developers\' and the reserves\' lines are not seats');
  // under a base fee no seat's share of a 1 sat stake pays its own output: no fee lock, as for every round (Pick b)
  const tiny = feeLockPays({ contract: { ...V27, stakeMsat: 1000n }, fees: { ppm: 0n, baseMsat: 1000n }, feeBps: giftsFeeBps() });
  assert.equal(tiny.pays, false);
  // below 27 the gate is today's
  const old = feeLockPays({ contract: V20, fees });
  assert.equal(old.lockMsat, 4000n);
  assert.equal(old.pays, true, old.why);
  assert.ok(refundKeyOf(SEATS[0]).length === 33);
});
