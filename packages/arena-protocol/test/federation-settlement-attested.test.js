// 2026.0.3 STEP 5c - AN ATTESTED MARKET THAT TAKES ANY FEDERATION SETTLES ONE TRANSACTION PER FEDERATION (kanban #348). Its plan is
// decided once (pariMutuelTable -> attestedLockSettlement, no fee) and split: each federation claims only the losing locks it holds,
// every winner gets the same fraction of each federation's pot (paid to its refund key there), the fee locks pay the nodes per pot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedLockSettlement } from '../src/lock-settlement.js';
import { splitByFederation } from '../src/federation-settlement.js';
import { pariMutuelTable } from '../src/attested.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const STAKE = 1000000n, FEE = 5000n; // the market's node fee, 0.5 % (feeBps 50)
// up (pick 0) wins: W1 in A, W2 in B; down (pick 1) loses: L1 in A, L2 in B, L3 in B (more stake on B's side)
const players = [[1, 0, A], [2, 0, B], [3, 1, A], [4, 1, B], [5, 1, B]];
const entries = players.map(([n, pick]) => ({ entryId: toHex(b32(0x10 + n)), pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, pick }));
const fedOf = new Map(players.map(([n, , f]) => [n, f]));
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

test('an attested market across two federations: each claims its own losing locks, each winner the same fraction of each pot', () => {
  const table = pariMutuelTable({ entries, outcome: 0 });
  const plan = attestedLockSettlement({ roundId: b32(0x5f), table, entries, locks, fees: NO_FEES, feeLocks, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes }, feeBps: 50 });
  assert.equal(plan.ok, true, plan.why);
  const got = splitByFederation(plan, { roundId: b32(0x5f), federationOf: (o) => fedOf.get(Number(o.outIdx)), feesOf: (f) => (f === A ? { ppm: 0n, baseMsat: 1000n } : NO_FEES) });
  assert.equal(got.ok, true, got.why);
  const [a, b] = got.settlements;
  assert.deepEqual([a.federation, b.federation], [A, B]);
  const stakeClaims = (s) => s.claims.filter((c) => c.kind !== 'fee').map((c) => Number(c.outIdx ?? c.outpoint.outIdx)).sort();
  assert.deepEqual(stakeClaims(a), [3], 'A claims only L1');
  assert.deepEqual(stakeClaims(b), [4, 5], 'B claims L2 and L3');
  // both winners are paid in both federations, to the same refund key; W1 and W2 bet the same, so they share each pot evenly
  const paid = (s, n) => s.payouts.filter((p) => p.kind === 'qualifier' && toHex(p.payoutPk) === toHex(refund(n))).reduce((t, p) => t + p.msat, 0n);
  for (const s of [a, b]) assert.ok(paid(s, 1) > 0n && paid(s, 2) > 0n, s.federation);
  assert.ok(paid(b, 1) - paid(b, 2) <= 1n && paid(b, 2) - paid(b, 1) <= 1n, 'even in B (no fee there)');
  // nothing created: each federation pays no more than its spendable pot, and B (no fees) pays all of its losers' stakes
  for (const s of [a, b]) assert.ok(s.unspentMsat >= 0n && s.feeUnspentMsat >= 0n);
  assert.equal(paid(b, 1) + paid(b, 2), 2n * (STAKE - FEE));
  // the fee locks: each federation's pays the nodes from its own pot
  for (const s of [a, b]) assert.ok(s.payouts.some((p) => p.kind === 'signer node'), `${s.federation}: nodes paid from its fee locks`);
  console.log('  A:', JSON.stringify({ claims: stakeClaims(a), w1: String(paid(a, 1)), w2: String(paid(a, 2)), fees: String(a.inputFeesMsat) }),
    '\n  B:', JSON.stringify({ claims: stakeClaims(b), w1: String(paid(b, 1)), w2: String(paid(b, 2)) }));
});
