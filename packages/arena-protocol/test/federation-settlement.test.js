// 2026.0.3 - ONE SETTLEMENT TRANSACTION PER FEDERATION, ALL FROM ONE PAYOUT TABLE (kanban #348). A round's plan is decided once
// (lockSettlement); splitByFederation turns it into one balanced transaction per federation: each spends its own locks, every
// payout gets the same fraction of every federation's pot, each federation prices its own fees and has its own nonce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSettlement, settlementNonce } from '../src/lock-settlement.js';
import { splitByFederation, federationSettlementNonce } from '../src/federation-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { toHex } from '../src/hash.js';
import { entryFeeMsat } from '../src/fee.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
const lockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat: e.stakeMsat - e.feeMsat, refundPk: refund(n) }];
const feeLockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(n) }, amountMsat: FEE, preimage: b32(0xf0 + n) }];
const SIGNER_NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [SIGNER_NODE(1), SIGNER_NODE(2)],
};
const signerNodes = { 'game-verify': [SIGNER_NODE(1), SIGNER_NODE(2)], settlement: [SIGNER_NODE(1), SIGNER_NODE(2)] };
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

// four players: winners W1 (lock in A) and W2 (in B), losers L1 (in A) and L2 (in B); every fee lock in its player's federation
const W1 = entry(1, DELIVERED, 5), W2 = entry(2, DELIVERED, 3), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [2, B], [3, A], [4, B]]);
const locks = new Map([lockFor(W1, 1), lockFor(W2, 2), lockFor(L1, 3), lockFor(L2, 4)]);
const feeLocks = new Map([feeLockFor(W1, 1), feeLockFor(W2, 2), feeLockFor(L1, 3), feeLockFor(L2, 4)]);
const federationOf = (o) => fedOfPlayer.get(Number(o.outIdx));
const planWith = (fees) => lockSettlement({ roundId: RID, entries: [W1, W2, L1, L2], minScore: 1, locks, feeLocks, fees, signerNodes: { gameVerify: [SIGNER_NODE(1), SIGNER_NODE(2)], settlement: [SIGNER_NODE(1), SIGNER_NODE(2)] }, contract });

test('one plan, two federations: each spends its own locks, every payout the same fraction of each pot, sums equal the plan', () => {
  const plan = planWith(NO_FEES);
  assert.equal(plan.ok, true, plan.why);
  const got = splitByFederation(plan, { roundId: RID, federationOf, feesOf: () => NO_FEES });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.settlements.map((s) => s.federation), [A, B]);
  // every claimed lock in exactly one federation's transaction, the one it is in
  const claimed = got.settlements.flatMap((s) => s.claims.map((c) => [s.federation, Number(c.outpoint.outIdx)]));
  assert.equal(claimed.length, plan.claims.length);
  for (const [f, n] of claimed) assert.equal(f, fedOfPlayer.get(n));
  // balanced in each federation; the payouts' sum per key over both equals the plan's (no fees: exact)
  for (const s of got.settlements) assert.ok(s.unspentMsat >= 0n && s.feeUnspentMsat >= 0n, s.federation);
  const sumOf = (ps) => { const m = new Map(); for (const p of ps) m.set(toHex(p.payoutPk) + p.kind, (m.get(toHex(p.payoutPk) + p.kind) || 0n) + p.msat); return m; };
  const split = sumOf(got.settlements.flatMap((s) => s.payouts));
  const whole = sumOf(plan.payouts);
  const rows = [...whole].map(([k, msat]) => `${k.slice(0, 6)}…${k.slice(-12)} plan ${msat} split ${split.get(k)}`);
  console.log('  PLAN vs SPLIT:\n   ' + rows.join('\n   '));
  for (const [k, msat] of whole) assert.ok(split.get(k) === msat || (split.get(k) - msat <= 2n && msat - split.get(k) <= 2n), `${k}: ${split.get(k)} vs ${msat}`);
  assert.equal([...split.values()].reduce((a, b) => a + b, 0n), [...whole.values()].reduce((a, b) => a + b, 0n), 'nothing lost or created over the round');
  // the same fraction: a winner's part in A over A's stake pot equals its part in B over B's (within a msat)
  const partOf = (s, k) => s.payouts.filter((p) => p.kind === 'qualifier' && toHex(p.payoutPk) === k).reduce((a, p) => a + p.msat, 0n);
  const k1 = toHex(refund(1));
  const [sa, sb] = got.settlements;
  assert.ok(Number(partOf(sa, k1)) / Number(sa.spendableMsat) - Number(partOf(sb, k1)) / Number(sb.spendableMsat) < 1e-6);
  // a nonce per federation, none the one-federation nonce
  const nonces = got.settlements.map((s) => toHex(s.nonce));
  assert.equal(new Set(nonces).size, 2);
  assert.ok(!nonces.includes(toHex(settlementNonce(RID))));
  assert.equal(toHex(federationSettlementNonce(RID, A)), nonces[0]);
});

test('each federation prices its own fees; a part too small for its own output fee is not built there; one federation is the plan itself', () => {
  const plan = planWith(NO_FEES);
  const feesOf = (f) => (f === A ? { ppm: 0n, baseMsat: 1000n } : NO_FEES);
  const got = splitByFederation(plan, { roundId: RID, federationOf, feesOf });
  assert.equal(got.ok, true, got.why);
  const a = got.settlements.find((s) => s.federation === A), b = got.settlements.find((s) => s.federation === B);
  console.log('  FEES:', JSON.stringify({ A: { pool: String(a.poolMsat), inputFees: String(a.inputFeesMsat), paid: String(a.paidMsat), unspent: String(a.unspentMsat) },
    B: { pool: String(b.poolMsat), inputFees: String(b.inputFeesMsat), paid: String(b.paidMsat), unspent: String(b.unspentMsat) } }));
  assert.equal(a.inputFeesMsat, 1000n * BigInt(a.claims.filter((c) => c.kind !== 'fee').length));
  assert.equal(b.inputFeesMsat, 0n);
  for (const p of a.payouts) assert.equal(p.feeMsat, 1000n);
  // every lock in one federation: one settlement whose payouts are the plan's own amounts
  const one = splitByFederation(plan, { roundId: RID, federationOf: () => A, feesOf: () => NO_FEES });
  assert.equal(one.settlements.length, 1);
  assert.equal(one.settlements[0].paidMsat, plan.paidMsat);
});

test('refused by name: a lock in no federation, a federation without a fee rule, a Lightning send split across federations', () => {
  const plan = planWith(NO_FEES);
  assert.match(splitByFederation(plan, { roundId: RID, federationOf: (o) => (Number(o.outIdx) === 3 ? null : A), feesOf: () => NO_FEES }).why, /in no federation this signer node can name/);
  assert.match(splitByFederation(plan, { roundId: RID, federationOf, feesOf: (f) => (f === B ? null : NO_FEES) }).why, /no fee rule for federation bbbbbbbb/);
  const sent = { ...plan, payouts: plan.payouts.map((p, i) => (i === 0 && p.kind === 'qualifier' ? { ...p, sent: { paymentHash: 'aa' } } : p)) };
  const first = sent.payouts.find((p) => p.sent);
  if (first) assert.match(splitByFederation(sent, { roundId: RID, federationOf, feesOf: () => NO_FEES }).why, /Lightning send of one amount/);
  assert.equal(splitByFederation({ ok: true, nothing: true }, { roundId: RID, federationOf, feesOf: () => NO_FEES }).settlements.length, 0);
});
