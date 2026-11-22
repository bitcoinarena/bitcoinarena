// Audit settle-r1 finding 1: a round that takes any federation claims a federation's fee locks even when that federation's
// part of the fee pays no signer node - the players' fees then go to the guardians only. The one-federation path refuses to
// claim such fee locks (lock-settlement.js feeSettlement: "A FEE THAT CANNOT REACH A SIGNER NODE IS NOT CLAIMED ... claimed,
// the players' fees would only have paid the guardians. Left unclaimed, each fee lock expires back to its player").
// Fixed from protocol 33 (kanban #2983, owner 2026-11-22): the seat passes unreachedFeesStay = runsDisjointRules(contract.protocolVersion); a
// round below 33 keeps the old split byte for byte (control at the end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSettlement, feeLockPays } from '../src/lock-settlement.js';
import { splitByFederation } from '../src/federation-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { toHex } from '../src/hash.js';
import { entryFeeMsat } from '../src/fee.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { DISJOINT_RULES_VERSION, TIE_SPLIT_VERSION, runsDisjointRules } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };
// the guardians' real rule as feeSettlement's own comment measured it: 1000 msat per input and per output
const REAL = { ppm: 0n, baseMsat: 1000n };
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);   // a 100 sat stake: a 5000 msat fee lock each
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
const lockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat: e.stakeMsat - e.feeMsat, refundPk: refund(n) }];
const feeLockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(100 + n) }, amountMsat: FEE, preimage: b32(0xf0 + n) }];
const SIGNER_NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [SIGNER_NODE(1), SIGNER_NODE(2)],
};
// a 5-of-7 committee: the same seven sitting nodes in both pools
const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(SIGNER_NODE);
const signerNodes = { gameVerify: SEVEN, settlement: SEVEN };
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

// two players: the winner W locks in federation A, the loser L in federation B; each fee lock in its player's federation
const W = entry(1, DELIVERED, 5), L = entry(2, FAILED, 0);
const fedOf = new Map([[1, A], [2, B], [101, A], [102, B]]);
const locks = new Map([lockFor(W, 1), lockFor(L, 2)]);
const feeLocks = new Map([feeLockFor(W, 1), feeLockFor(L, 2)]);
const federationOf = (o) => fedOf.get(Number(o.outIdx));
const planWith = (fees) => lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks, feeLocks, fees, signerNodes, contract });

test('one federation: the same two fee locks pay every sitting node (the control: the page\'s feeLockPays gate passes them)', () => {
  const one = planWith(REAL);
  assert.equal(one.ok, true, one.why);
  assert.equal(one.feeClaims.length, 2);
  assert.ok(one.feePaidMsat > 0n);
  const gate = feeLockPays({ contract: { ...contract, nodes: SEVEN, gameVerifySlots: 7, settlementSlots: 7 }, fees: REAL });
  console.log('  page gate feeLockPays:', JSON.stringify({ pays: gate.pays, why: gate.why }));
});

test('any federation: no federation claims fee locks whose part pays no signer node', () => {
  // the seat's federationPlans: the plan decided with no fee, then split, each federation priced by its own rule
  const plan = planWith(NO_FEES);
  assert.equal(plan.ok, true, plan.why);
  const got = splitByFederation(plan, { roundId: RID, federationOf, feesOf: () => REAL, unreachedFeesStay: runsDisjointRules(DISJOINT_RULES_VERSION) });
  assert.equal(got.ok, true, got.why);
  for (const s of got.settlements) {
    const feeClaims = s.claims.filter((c) => c.kind === 'fee');
    const claimedMsat = feeClaims.reduce((t, c) => t + c.amountMsat, 0n);
    console.log(`  federation ${s.federation.slice(0, 8)}: fee locks claimed ${claimedMsat} msat, fee part paid ${s.feePaidMsat} msat, to the guardians ${s.feeUnspentMsat} msat + input fees`);
    if (feeClaims.length) assert.ok(s.feePaidMsat > 0n,
      `federation ${s.federation.slice(0, 8)} claims ${claimedMsat} msat of players' fee locks and pays no signer node: the fee only pays the guardians`);
  }
});

test('any federation below 33: the split is unchanged (the old claims, byte for byte)', () => {
  const plan = planWith(NO_FEES);
  const old = splitByFederation(plan, { roundId: RID, federationOf, feesOf: () => REAL });
  const gated = splitByFederation(plan, { roundId: RID, federationOf, feesOf: () => REAL, unreachedFeesStay: runsDisjointRules(TIE_SPLIT_VERSION) });
  const j = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? toHex(v) : v));
  assert.equal(j(gated), j(old));
  assert.ok(old.settlements.some((s) => s.claims.some((c) => c.kind === 'fee') && s.feePaidMsat === 0n), 'below 33 the hole is still claimed (the old rule)');
  const now = splitByFederation(plan, { roundId: RID, federationOf, feesOf: () => REAL, unreachedFeesStay: true });
  assert.ok(now.feeHoles && now.feeHoles.length >= 1, 'from 33 the hole is named');
});
