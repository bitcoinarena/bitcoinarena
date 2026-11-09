// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1331 (1), §13A.1 RULED 2026-11-07: the auditors' unpaid remainder goes to the protocol reserves - for a round that takes any federation,
// each federation's part to its own reserve key (the plan names RESERVE_LATER_PK, splitByFederation re-keys it, as a market's reserve).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationPlans, LockSettlement } from '../src/settlement.js';
import { RESERVE_LATER_PK } from '../../arena-protocol/src/lock-settlement.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const RID = b32(0x5f), SEATS = [pk(0x71), pk(0x72), pk(0x73)];
const STAKE = 100000n, FEE = entryFeeMsat(STAKE);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
const lockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat: e.stakeMsat - e.feeMsat, refundPk: refundKeyOf(e.pubkey) }];
const feeLockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x60 + n), outIdx: BigInt(n) }, amountMsat: e.feeMsat, preimage: b32(0x80 + n), refundPk: refundKeyOf(e.pubkey) }];
const A = 'a1'.repeat(32), B = 'b2'.repeat(32);
const KA = Uint8Array.from([0x02, ...b32(0x5a)]), KB = Uint8Array.from([0x03, ...b32(0x5b)]);
// the named-claim-payees fixture's round (a nextblock round of protocol 27), its federation set to "any"
const ROUND = { networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: SEATS, protocolVersion: 27 };

test('#1331 a round taking any federation: the auditors\' remainder is split, each federation\'s part to its own reserve key', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const fedOf = new Map([[1n, A], [2n, B]]);
  const args = { roundId: RID, entries: [W, L], minScore: 1, contract: ROUND, feeBps: 500, signerNodes: { gameVerify: SEATS, settlement: SEATS, auditors: [], auditReserveKey: RESERVE_LATER_PK },
    locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) };
  const got = federationPlans(args, { federationOf: (o) => fedOf.get(BigInt(o.outIdx)), feesOf: () => ({ ppm: 0n, baseMsat: 0n }), reserveKeyOf: (f) => (f === A ? KA : f === B ? KB : null) });
  assert.equal(got.ok, true, got.why);
  const reserveOf = (fid) => ((got.split.settlements.find((x) => x.federation === fid) || {}).payouts || []).filter((p) => p.auditRemainder);
  const planned = got.plan.payouts.filter((p) => p.auditRemainder).reduce((a, p) => a + p.msat, 0n);
  const ra = reserveOf(A), rb = reserveOf(B);
  console.log('  MEASURED #1331 any federation:', JSON.stringify({ planned: String(planned), A: ra.map((p) => [toHex(p.payoutPk).slice(0, 4), String(p.msat)]), B: rb.map((p) => [toHex(p.payoutPk).slice(0, 4), String(p.msat)]) }));
  assert.ok(planned > 0n, 'no remainder planned');
  assert.ok(ra.length && rb.length, 'each federation pays its part');
  assert.ok(ra.every((p) => toHex(p.payoutPk) === toHex(KA)) && rb.every((p) => toHex(p.payoutPk) === toHex(KB)));
  // a federation with no reserve key: the split is refused, nothing built
  const none = federationPlans(args, { federationOf: (o) => fedOf.get(BigInt(o.outIdx)), feesOf: () => ({ ppm: 0n, baseMsat: 0n }), reserveKeyOf: (f) => (f === A ? KA : null) });
  assert.equal(none.ok, false);
  assert.match(none.why, /names no reserve key, and this round pays the protocol reserve/);
});

test('#1331 a late loser of a round taking any federation: its plan carries its lock\'s federation\'s reserve key; with none named, the old rule', async () => {
  const asked = [];
  const seat = new LockSettlement({}, { signerNodesFor: () => ({ gameVerify: [], settlement: [] }), auditedRoundOf: () => true, reserveKeyFor: async (f) => { asked.push(f); return KB; } });
  const any = { protocolVersion: 22, stakeMsat: 1000n, federationId: new Uint8Array(32), nodes: [] };
  const late = await seat.signerNodesWithReserve(RID, any, B);
  assert.equal(toHex(late.signerNodes.auditReserveKey), toHex(KB));
  assert.deepEqual(asked, [B]);
  const old = await seat.signerNodesWithReserve(RID, any);
  assert.equal(old.signerNodes.auditReserveKey, undefined);
});
