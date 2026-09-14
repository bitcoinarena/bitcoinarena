// W4: A LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// QUALIFIERS ARE PAID FROM IT (the owner 2026-09-14 07:22; FEDERATION.md step 5).
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import assert from 'node:assert/strict';

import { lockSettlement, lnv2FeeMsat, largestPayoutMsat, settlementNonce, feeLockPays } from '../src/lock-settlement.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };

/** An entry at 100 sat, 2% fee, and the given donation. */
const entry = (n, outcome, score, donationMsat = 0n) => ({ pubkey: pk(n), stakeMsat: 100000n, feeMsat: 2000n, donationMsat, outcome, score });
const lockFor = (e, n, amountMsat = 100000n - 2000n - e.donationMsat) =>
  [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat, refundPk: refund(n) }];

test('round 5\'s outcomes on locks: the 0% loser\'s 98000 msat is claimed, the 0% winner is paid 98000 from it, the 2% winner is owed nothing on top', () => {
  const D2 = entry(1, DELIVERED, 1, 2000n);
  const Z0 = entry(2, DELIVERED, 3);
  const PAGE = entry(3, FAILED, 0);
  const locks = new Map([lockFor(D2, 1), lockFor(Z0, 2), lockFor(PAGE, 3)]);
  const s = lockSettlement({ roundId: RID, entries: [D2, Z0, PAGE], minScore: 1, locks, fees: NO_FEES });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => [toHex(c.pubkey), c.amountMsat]), [[toHex(PAGE.pubkey), 98000n]]);
  assert.deepEqual(s.payouts.map((p) => [toHex(p.payoutPk), p.owedMsat, p.msat]), [[toHex(refund(2)), 98000n, 98000n]]);
  assert.deepEqual(s.forfeits.map(toHex).sort(), [toHex(D2.pubkey), toHex(Z0.pubkey)].sort(), 'both winners\' own locks are forfeited back');
  assert.deepEqual([s.poolMsat, s.paidMsat, s.unspentMsat], [98000n, 98000n, 0n]);
});

test('the guardians\' fees come out of the pool: 0.1% on the claimed lock and on the payout, to the millisatoshi', () => {
  const fees = { ppm: 1000n, baseMsat: 0n };
  assert.equal(lnv2FeeMsat(fees, 98000n), 98n);
  assert.equal(largestPayoutMsat(fees, 97902n), 97805n, '97805 + 97 = 97902, and 97806 + 97 is one too many');
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), fees });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([s.poolMsat, s.inputFeesMsat, s.spendableMsat], [98000n, 98n, 97902n]);
  assert.deepEqual(s.payouts.map((p) => [p.owedMsat, p.msat, p.feeMsat]), [[98000n, 97805n, 97n]]);
  assert.equal(s.unspentMsat, 0n);
});

// TWO PAYING RANKS NEED FIVE QUALIFIERS: K = ceil(qualifiers / 4), and under 22A
// pick A one paying rank takes the whole pool - the others get their own stake
// back by the forfeit and nothing on top.
test('two paying ranks share the fees pro rata to what each is owed, and every millisatoshi of the pool is accounted for', () => {
  const fees = { ppm: 2500n, baseMsat: 7n };
  const qualifiers = [900, 800, 700, 600, 500].map((score, i) => entry(i + 1, DELIVERED, score));
  const losers = [6, 7, 8].map((n) => entry(n, FAILED, 0));
  const all = [...qualifiers, ...losers];
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const s = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.claims.length, 3);
  assert.equal(s.poolMsat, 3n * 98000n);
  assert.equal(s.payouts.length, 2, 'five qualifiers make two paying ranks');
  assert.equal(s.forfeits.length, 5, 'every qualifier\'s own lock is forfeited back');
  assert.equal(s.payouts.reduce((t, p) => t + p.owedMsat, 0n), s.poolMsat, 'the table hands out exactly the claimed pool');
  assert.equal(s.inputFeesMsat + s.paidMsat + s.outputFeesMsat + s.unspentMsat, s.poolMsat, 'a millisatoshi was created or lost');
  assert.ok(s.unspentMsat >= 0n && s.unspentMsat < 2n, `the floors left ${s.unspentMsat} msat`);
  const [a, b] = [...s.payouts].sort((x, y) => (x.owedMsat > y.owedMsat ? -1 : 1));
  assert.ok(a.msat > b.msat, 'the higher rank is not paid more');
  for (const p of s.payouts) assert.ok(p.msat + p.feeMsat <= (p.owedMsat * s.spendableMsat) / s.poolMsat, 'a payout took more than its part');
  console.log(`  two qualifiers: pool ${s.poolMsat}, input fees ${s.inputFeesMsat}, payouts ${s.payouts.map((p) => `${p.msat}+${p.feeMsat}`).join(', ')}, unspent ${s.unspentMsat}`);
});

test('a loser whose lock no seat verified, or whose lock holds another amount, is refused - nothing is claimed on a guess', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const missing = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1)]), fees: NO_FEES });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /never verified/);
  const wrong = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2, 99000n)]), fees: NO_FEES });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /holds 99000 msat and its entry's net stake is 98000/);
});

test('a VOID entry\'s lock is never claimed, and a FORFEIT loser\'s is', () => {
  const W = entry(1, DELIVERED, 3);
  const F = entry(2, FORFEIT, 0);
  const V = entry(3, VOID, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, F, V], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(F, 2), lockFor(V, 3)]), fees: NO_FEES });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => toHex(c.pubkey)), [toHex(F.pubkey)]);
  assert.deepEqual(s.payouts.map((p) => p.msat), [98000n]);
});

test('every seat rebuilds the same transaction: the order of the entries it was handed changes nothing, and the nonce is the round\'s', () => {
  const fees = { ppm: 1000n, baseMsat: 3n };
  const all = [entry(1, DELIVERED, 900), entry(2, DELIVERED, 50), entry(3, FAILED, 0), entry(4, FORFEIT, 0)];
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const one = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees });
  const two = lockSettlement({ roundId: RID, entries: [...all].reverse(), minScore: 1, locks, fees });
  const shape = (s) => JSON.stringify({ c: s.claims.map((c) => [toHex(c.outpoint.txid), String(c.outpoint.outIdx), String(c.amountMsat)]),
    p: s.payouts.map((p) => [toHex(p.payoutPk), String(p.msat)]), n: toHex(s.nonce) });
  assert.equal(shape(two), shape(one));
  assert.equal(settlementNonce(RID).length, 8);
  assert.equal(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x5f))));
  assert.notEqual(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x60))));
});

// PICK A (the owner 2026-09-14): THE FEE LOCKS PAY THE SITTING SEATS, by §22A's weights.
const SEAT = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const contractOf = (nodes) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN',
  custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes,
});
const feeLockFor = (e, n, amountMsat = 2000n) =>
  [toHex(e.pubkey), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(n) }, amountMsat, preimage: b32(0xf0 + n) }];

test('every counted entry\'s 2000 msat fee lock is claimed in the same settlement and the two sitting seats are paid by §22A\'s weights - winners\' fee locks too, a VOID entry\'s not', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const V = entry(3, VOID, 0);
  const seats = [SEAT(1), SEAT(2)];
  const s = lockSettlement({ roundId: RID, entries: [W, L, V], minScore: 1, fees: NO_FEES, contract: contractOf(seats),
    seats: { gameVerify: seats, settlement: seats },
    locks: new Map([lockFor(W, 1), lockFor(L, 2), lockFor(V, 3)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2), feeLockFor(V, 3)]) });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.feeClaims.map((c) => toHex(c.pubkey)).sort(), [toHex(W.pubkey), toHex(L.pubkey)].sort(), 'the fee locks claimed are not exactly the counted entries\'');
  assert.equal(s.feePoolMsat, 4000n, 'two counted entries at 2% of 100000');
  // 1% + 1% of the 200000 gross, each seat in both pools: 2000 owed to each, paid whole with no guardian fee
  assert.deepEqual(s.seatPayouts.map((p) => [toHex(p.payoutPk), p.owedMsat, p.msat]).sort(), seats.map((k) => [toHex(refundKeyOf(k)), 2000n, 2000n]).sort());
  assert.equal(s.claims.length, 3, 'one stake lock and two fee locks in one transaction');
  assert.ok(s.payouts.some((p) => p.kind === 'qualifier'), 'the winner is still paid');
  assert.equal(s.feeHole, null);
});

// MEASURED: UNDER THE REAL GUARDIANS' RULE (1000 msat per input and output, stake-lock-step3.sh)
// A 2000 msat fee lock cannot reach a seat - so it is not claimed, and the hole is named.
test('under the real guardians\' 1000 msat per input and output, 100 sat rounds\' 2000 msat fee locks cannot pay a seat: none is claimed, each expires back, the hole is named in msat', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const seats = [SEAT(1), SEAT(2)];
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: { ppm: 0n, baseMsat: 1000n }, contract: contractOf(seats),
    seats: { gameVerify: seats, settlement: seats }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]),
    feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  console.log(`  real fee rule: fee claims ${s.feeClaims.length}; hole ${s.feeHole && `${s.feeHole.poolMsat} msat pool, ${s.feeHole.inputFeesMsat} input fees, ${s.feeHole.owedMsat} owed`}; `
    + `seats owed ${s.unpaid.filter((u) => /fee share/.test(u.why)).map((u) => u.owedMsat).join(', ')}; the winner still paid ${s.payouts.filter((p) => p.kind === 'qualifier').map((p) => p.msat).join(', ')}`);
  assert.equal(s.ok, true, s.why);
  assert.equal(s.feeClaims.length, 0, 'fee locks were claimed that pay no seat - the players\' fees would only pay the guardians');
  assert.deepEqual([s.feeHole.poolMsat, s.feeHole.inputFeesMsat, s.feeHole.owedMsat], [4000n, 2000n, 4000n]);
  assert.deepEqual(s.unpaid.filter((u) => /fee share/.test(u.why)).map((u) => u.owedMsat), [2000n, 2000n]);
  assert.deepEqual(s.payouts.map((p) => [p.kind, p.msat]), [['qualifier', 96000n]], 'the stake part changed');
});

test('under a proportional fee rule each sitting seat is paid its share of the fee locks, less its part of the guardians\' fees', () => {
  const players = [entry(1, DELIVERED, 900), entry(2, FAILED, 0), entry(3, FAILED, 0), entry(4, FORFEIT, 0)];
  const seats = [SEAT(1), SEAT(2)];
  const s = lockSettlement({ roundId: RID, entries: players, minScore: 1, fees: { ppm: 1000n, baseMsat: 0n }, contract: contractOf(seats),
    seats: { gameVerify: seats, settlement: seats }, locks: new Map(players.map((e, i) => lockFor(e, i + 1))),
    feeLocks: new Map(players.map((e, i) => feeLockFor(e, i + 1))) });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.feePoolMsat, 8000n);
  assert.equal(s.seatPayouts.length, 2);
  for (const p of s.seatPayouts) {
    assert.equal(p.owedMsat, 4000n, 'each seat is in both pools: 1% + 1% of 400000, halved');
    assert.ok(p.msat + p.feeMsat <= 4000n - 4n, `a seat took more than its share less its part of the input fees: ${p.msat}+${p.feeMsat}`);
  }
  assert.equal(s.feeInputFeesMsat + s.feePaidMsat + s.feeOutputFeesMsat + s.feeUnspentMsat, s.feePoolMsat);
  console.log(`  proportional: fee pool ${s.feePoolMsat}, input fees ${s.feeInputFeesMsat}, seats ${s.seatPayouts.map((p) => `${p.msat}+${p.feeMsat}`).join(', ')}, unspent ${s.feeUnspentMsat}`);
});

test('a round with losers and no qualifier still claims its fee locks for the seats, and claims no stake', () => {
  const L1 = entry(1, FAILED, 0);
  const L2 = entry(2, FORFEIT, 0);
  const seats = [SEAT(1), SEAT(2)];
  const s = lockSettlement({ roundId: RID, entries: [L1, L2], minScore: 1, fees: NO_FEES, contract: contractOf(seats),
    seats: { gameVerify: seats, settlement: seats }, locks: new Map([lockFor(L1, 1), lockFor(L2, 2)]),
    feeLocks: new Map([feeLockFor(L1, 1), feeLockFor(L2, 2)]) });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.claims.every((c) => c.kind === 'fee'), true, 'a stake was claimed with nobody to pay');
  assert.match(s.stakeWhy, /operator would keep/);
  assert.deepEqual(s.seatPayouts.map((p) => p.msat).sort(), [2000n, 2000n]);
});

test('a counted entry with no verified fee lock, a fee lock of another amount, or no seats named: nothing is claimed', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const seats = [SEAT(1), SEAT(2)];
  const base = { roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, contract: contractOf(seats), locks: new Map([lockFor(W, 1), lockFor(L, 2)]) };
  const missing = lockSettlement({ ...base, seats: { gameVerify: seats, settlement: seats }, feeLocks: new Map([feeLockFor(W, 1)]) });
  assert.match(missing.why, /fee lock was never verified/);
  const wrong = lockSettlement({ ...base, seats: { gameVerify: seats, settlement: seats }, feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2, 1999n)]) });
  assert.match(wrong.why, /fee lock holds 1999 msat and its entry's fee is 2000/);
  const noSeats = lockSettlement({ ...base, feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  assert.match(noSeats.why, /no contract or seats were named/);
});

// PICK (b) (the owner 2026-09-14): THE GATE - A FEE LOCK IS MINTED ONLY WHEN IT CAN PAY A SEAT.
const REAL_RULE = { ppm: 0n, baseMsat: 1000n };   // measured on fedimintd 0.12.0 (stake-lock-step3.sh)
const at = (stakeMsat) => ({ ...contractOf([SEAT(1), SEAT(2)]), stakeMsat });
const show = (g) => `stake ${g.stakeMsat} msat, lock ${g.lockMsat}, ${g.players} players, ${g.seats} seats, input fees ${g.inputFeesMsat}, `
  + `output fees ${g.outputFeesMsat}, per-seat net [${(g.perSeatNetMsat || []).join(', ')}], unpaid ${g.unpaidSeats} - ${g.pays ? 'MINT' : 'NO LOCK'}: ${g.why}`;

test('the gate: a 100 sat round with two players mints no fee lock - its 2000 msat lock would only pay the federation', () => {
  const g = feeLockPays({ contract: at(100000n), fees: REAL_RULE });
  console.log(`  100 sat: ${show(g)}`);
  assert.equal(g.pays, false);
  assert.equal(g.lockMsat, 2000n);
});

test('the gate: a 1000 sat round mints its 20000 msat fee lock, and every sitting seat nets more than nothing after 1000 msat per input and per output', () => {
  const g = feeLockPays({ contract: at(1000000n), fees: REAL_RULE });
  console.log(`  1000 sat: ${show(g)}`);
  assert.equal(g.pays, true, g.why);
  assert.equal(g.lockMsat, 20000n);
  assert.equal(g.perSeatNetMsat.length, 4, 'every entitled seat - two game/verify, two settlement, as different keys');
  for (const net of g.perSeatNetMsat) assert.ok(net > 0n, `a seat nets ${net}`);
  assert.equal(g.inputFeesMsat, 2000n, 'two fee locks in, 1000 msat each');
  assert.equal(g.outputFeesMsat, 4000n, 'four seat payouts out, 1000 msat each');
});

test('the gate\'s floor, measured: the smallest stake it mints for, and 1000 sat the smallest bracket (10 / 100 / 1000 sat) above it', () => {
  let lo = 1000n; let hi = 1000000n;   // 1 sat fails, 1000 sat passes (above)
  assert.equal(feeLockPays({ contract: at(lo), fees: REAL_RULE }).pays, false);
  while (hi - lo > 1000n) { const mid = ((lo + hi) / 2n / 1000n) * 1000n; if (feeLockPays({ contract: at(mid), fees: REAL_RULE }).pays) hi = mid; else lo = mid; }
  const floor = feeLockPays({ contract: at(hi), fees: REAL_RULE });
  console.log(`  the floor: ${hi / 1000n} sat mints (${show(floor)}); ${lo / 1000n} sat does not`);
  assert.equal(floor.pays, true);
  const brackets = [10000n, 100000n, 1000000n].map((s) => [s / 1000n, feeLockPays({ contract: at(s), fees: REAL_RULE }).pays]);
  console.log(`  brackets: ${brackets.map(([s, p]) => `${s} sat ${p ? 'mints' : 'no lock'}`).join(', ')}`);
  assert.deepEqual(brackets.map(([, p]) => p), [false, false, true]);
});

test('with no federation fee rule known the gate mints nothing', () => {
  assert.equal(feeLockPays({ contract: at(1000000n), fees: null }).pays, false);
});

test('a round with losers and no qualifier: what the hold verdict decides, the lock settlement decides too', () => {
  const L1 = entry(1, FAILED, 0);
  const L2 = entry(2, FORFEIT, 0);
  const s = lockSettlement({ roundId: RID, entries: [L1, L2], minScore: 1, locks: new Map([lockFor(L1, 1), lockFor(L2, 2)]), fees: NO_FEES });
  // The hold path's verdict refuses this round ("the operator would keep ..."):
  // there is nobody to pay, so no hold is settled and each expires back. The lock
  // settlement refuses it the same way - nothing is claimed, each lock expires back
  // to its player. Whether a no-winner round's stakes should go anywhere else is
  // not decided here.
  console.log(`  no qualifier: ok ${s.ok}, why ${s.why || '-'}`);
  assert.equal(s.ok, false, 'a settlement with nobody to pay was built');
  assert.match(s.why, /operator would keep 196000 msat: a pool of 196000 against 0 handed out/);
});
