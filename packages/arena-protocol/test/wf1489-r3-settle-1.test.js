// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r3 settle-1: an attested market's settlement must spend the whole spendable losing pool on its winners (or name
// what it could not pay), as lockSettlement and lateLockSettlement do. A winner whose share does not cover the guardians'
// base output fee is dropped from the payouts WITHOUT being listed unpaid and WITHOUT its share being folded back, and the
// dust step still subtracts a base fee for the output that is never made - so that msat is left unspent in the
// transaction (the federation keeps it) instead of reaching the winners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedLockSettlement } from '../src/lock-settlement.js';
import { pariMutuelTable } from '../src/attested.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const FEES = { ppm: 0n, baseMsat: 1000n };
// pick 0 wins: W1 a big stake, W2 a small one; pick 1 loses: L3
const players = [[1, 0, 100000000n], [2, 0, 2000n], [3, 1, 10000000n]];
const entries = players.map(([n, pick, stake]) => ({ entryId: toHex(b32(0x10 + n)), pubkey: pk(n), stakeMsat: stake, feeMsat: stake / 200n, donationMsat: 0n, pick }));
const locks = new Map(entries.map((e, i) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + i), outIdx: BigInt(i) }, amountMsat: e.stakeMsat - e.feeMsat, refundPk: refund(i + 1) }]));
const nodes = [NODE(1), NODE(2)];
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
};

test('an attested settlement leaves nothing of the losing pool to the federation: every winner is paid or named unpaid', () => {
  const table = pariMutuelTable({ entries, outcome: 0 });
  const w2 = table.rows.find((r) => r.entryId === entries[1].entryId);
  console.log('  W2 owed excess', String(w2.payoutMsat - w2.netMsat), 'msat');
  const plan = attestedLockSettlement({ roundId: b32(0x5f), table, entries, locks, fees: FEES, feeLocks: new Map(), contract,
    signerNodes: { gameVerify: nodes, settlement: nodes }, feeBps: 50 });
  assert.equal(plan.ok, true, plan.why);
  const paidW2 = plan.payouts.some((p) => p.kind === 'qualifier' && toHex(p.pubkey) === toHex(pk(2)));
  const namedW2 = plan.unpaid.some((u) => toHex(u.pubkey) === toHex(pk(2)));
  console.log('  spendable', String(plan.spendableMsat), 'paid', String(plan.paidMsat), 'output fees', String(plan.outputFeesMsat),
    'unspent', String(plan.unspentMsat), 'W2 paid', paidW2, 'W2 named unpaid', namedW2);
  assert.ok(paidW2 || namedW2, 'a winner left out of the payouts is named in unpaid, as lockSettlement does');
  assert.equal(plan.unspentMsat, 0n, 'the spendable losing pool is spent on the winners and their output fees, nothing left to the federation');
});
