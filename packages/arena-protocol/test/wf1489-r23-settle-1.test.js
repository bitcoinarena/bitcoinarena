// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT #1489 r23-settle-1: a market whose terms the manifest allows (node fee 25 bps, donation 0) and whose stake is an odd
// number of sats: every entry's fee lock is floored per entry (fee.js entryFeeMsat, checked at the door by feeMatchesEntry),
// the fee table is floored once over the gross (nodeFeeTable). The two differ by up to one msat per entry, and feeSettlement
// demands they are equal - so the whole settlement is refused and the round never settles.
// SAFE: an honest round whose every entry passed the door settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedLockSettlement } from '../src/lock-settlement.js';
import { pariMutuelTable } from '../src/attested.js';
import { entryFeeMsat, feeMatchesEntry } from '../src/fee.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const FEE_BPS = 25;
const STAKE = 1001000n;                       // 1,001 sat
const FEE = entryFeeMsat(STAKE, FEE_BPS);     // 2502 msat (2502.5 floored)

test('r23-settle-1: an odd-sat market round under allowed terms (25 bps, no donation) settles', () => {
  const players = [[1, 0], [2, 1], [3, 1]];
  const entries = players.map(([n, pick]) => ({ entryId: toHex(b32(0x10 + n)), pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, pick }));
  for (const e of entries) assert.equal(feeMatchesEntry(e, { feeBps: FEE_BPS, donationInFee: true }).ok, true, 'each entry passes the door');
  const locks = new Map(players.map(([n]) => [toHex(pk(n)), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat: STAKE - FEE, refundPk: refund(n) }]));
  const feeLocks = new Map(players.map(([n]) => [toHex(pk(n)), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(n) }, amountMsat: FEE, preimage: b32(0xf0 + n) }]));
  const nodes = [NODE(1), NODE(2)];
  const contract = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const table = pariMutuelTable({ entries, outcome: 0 });
  const plan = attestedLockSettlement({ roundId: b32(0x5f), table, entries, locks, fees: NO_FEES, feeLocks, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes }, feeBps: FEE_BPS });
  console.log('  plan:', plan.ok, plan.why || '');
  assert.equal(plan.ok, true, `the round does not settle: ${plan.why}`);
});
