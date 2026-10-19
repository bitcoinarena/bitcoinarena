// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// W4: A LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// QUALIFIERS ARE PAID FROM IT (2026-09-14 07:22; FEDERATION.md step 5).
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import assert from 'node:assert/strict';

import { lockSettlement, lnv2FeeMsat, largestPayoutMsat, settlementNonce, feeLockPays } from '../src/lock-settlement.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { toHex } from '../src/hash.js';
import { entryFeeMsat } from '../src/fee.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };

// THE RULE'S FIGURES (§22A, §0A.8): an entry at 100 sat pays the node fee entryFeeMsat (5%) beside the donation;
// what it locks is the rest. Every amount below is one of these, or computed from them.
const STAKE = 100000n;
const FEE = entryFeeMsat(STAKE);
const NET = STAKE - FEE;
/** An entry at 100 sat, the rule's fee, and the given donation. */
const entry = (n, outcome, score, donationMsat = 0n) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat, outcome, score });
// THE QUALIFIERS WHO NAMED A LIGHTNING ADDRESS (ruled 2026-09-23): only they are paid.
const named = (...es) => new Set(es.map((e) => toHex(e.pubkey)));
const lockFor = (e, n, amountMsat = e.stakeMsat - e.feeMsat - e.donationMsat) =>
  [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat, refundPk: refund(n) }];

test('round 5\'s outcomes on locks: the loser\'s net stake is claimed, the non-donating winner is paid it, the donating winner is owed nothing on top', () => {
  const D2 = entry(1, DELIVERED, 1, 2000n);
  const Z0 = entry(2, DELIVERED, 3);
  const PAGE = entry(3, FAILED, 0);
  const locks = new Map([lockFor(D2, 1), lockFor(Z0, 2), lockFor(PAGE, 3)]);
  const s = lockSettlement({ roundId: RID, entries: [D2, Z0, PAGE], minScore: 1, locks, fees: NO_FEES, addressed: named(D2, Z0) });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => [toHex(c.pubkey), c.amountMsat]), [[toHex(PAGE.pubkey), NET]]);
  assert.deepEqual(s.payouts.map((p) => [toHex(p.payoutPk), p.owedMsat, p.msat]), [[toHex(refund(2)), NET, NET]]);
  assert.deepEqual(s.forfeits.map(toHex).sort(), [toHex(D2.pubkey), toHex(Z0.pubkey)].sort(), 'both winners\' own locks are forfeited back');
  assert.deepEqual([s.poolMsat, s.paidMsat, s.unspentMsat], [NET, NET, 0n]);
});

test('the guardians\' fees come out of the pool: 0.1% on the claimed lock and on the payout, to the millisatoshi', () => {
  const fees = { ppm: 1000n, baseMsat: 0n };
  assert.equal(lnv2FeeMsat(fees, 98000n), 98n);
  assert.equal(largestPayoutMsat(fees, 97902n), 97805n, '97805 + 97 = 97902, and 97806 + 97 is one too many');
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), fees, addressed: named(W) });
  assert.equal(s.ok, true, s.why);
  // the guardians' 0.1% on the claimed net stake, and the largest payout whose own fee fits in what is left
  const inFee = lnv2FeeMsat(fees, NET), spendable = NET - inFee, payout = largestPayoutMsat(fees, spendable);
  assert.deepEqual([s.poolMsat, s.inputFeesMsat, s.spendableMsat], [NET, inFee, spendable]);
  assert.deepEqual(s.payouts.map((p) => [p.owedMsat, p.msat, p.feeMsat]), [[NET, payout, lnv2FeeMsat(fees, payout)]]);
  assert.ok(payout + lnv2FeeMsat(fees, payout) <= spendable && payout + 1n + lnv2FeeMsat(fees, payout + 1n) > spendable, 'not the largest payout that fits');
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
  const s = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees, addressed: named(...qualifiers) });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.claims.length, 3);
  assert.equal(s.poolMsat, 3n * NET);
  assert.equal(s.payouts.length, 2, 'five qualifiers make two paying ranks');
  assert.equal(s.forfeits.length, 5, 'every qualifier\'s own lock is forfeited back');
  assert.equal(s.payouts.reduce((t, p) => t + p.owedMsat, 0n), s.poolMsat, 'the table hands out exactly the claimed pool');
  assert.equal(s.inputFeesMsat + s.paidMsat + s.outputFeesMsat + s.unspentMsat, s.poolMsat, 'a millisatoshi was created or lost');
  // THE DUST GOES TO THE FIRST ROW (ruled 2026-09-23): what the floors leave is paid, never left to the guardians -
  // up to the one msat a proportional fee's step can make unplaceable in any output.
  assert.ok(s.unspentMsat >= 0n && s.unspentMsat < 2n, `the floors left ${s.unspentMsat} msat`);
  const [a, b] = [...s.payouts].sort((x, y) => (x.owedMsat > y.owedMsat ? -1 : 1));
  assert.ok(a.msat > b.msat, 'the higher rank is not paid more');
  assert.ok(b.msat + b.feeMsat <= (b.owedMsat * s.spendableMsat) / s.poolMsat, 'the second row took more than its part');
  console.log(`  two qualifiers: pool ${s.poolMsat}, input fees ${s.inputFeesMsat}, payouts ${s.payouts.map((p) => `${p.msat}+${p.feeMsat}`).join(', ')}, unspent ${s.unspentMsat}`);
});

test('a loser whose lock no signer node verified, or whose lock holds another amount, is refused - nothing is claimed on a guess', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const missing = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1)]), fees: NO_FEES });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /never verified/);
  const wrong = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2, NET + 1000n)]), fees: NO_FEES });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, new RegExp(`holds ${NET + 1000n} msat and its entry's net stake is ${NET}`));
});

test('a VOID entry\'s lock is never claimed, and a FORFEIT loser\'s is', () => {
  const W = entry(1, DELIVERED, 3);
  const F = entry(2, FORFEIT, 0);
  const V = entry(3, VOID, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, F, V], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(F, 2), lockFor(V, 3)]), fees: NO_FEES, addressed: named(W) });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => toHex(c.pubkey)), [toHex(F.pubkey)]);
  assert.deepEqual(s.payouts.map((p) => p.msat), [NET]);
});

test('every signer node rebuilds the same transaction: the order of the entries it was handed changes nothing, and the nonce is the round\'s', () => {
  const fees = { ppm: 1000n, baseMsat: 3n };
  const all = [entry(1, DELIVERED, 900), entry(2, DELIVERED, 50), entry(3, FAILED, 0), entry(4, FORFEIT, 0)];
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const one = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees, addressed: named(all[0], all[1]) });
  const two = lockSettlement({ roundId: RID, entries: [...all].reverse(), minScore: 1, locks, fees, addressed: named(all[1], all[0]) });
  assert.equal(one.claims.length, 2, 'nothing was claimed, so nothing was compared');
  const shape = (s) => JSON.stringify({ c: s.claims.map((c) => [toHex(c.outpoint.txid), String(c.outpoint.outIdx), String(c.amountMsat)]),
    p: s.payouts.map((p) => [toHex(p.payoutPk), String(p.msat)]), n: toHex(s.nonce) });
  assert.equal(shape(two), shape(one));
  assert.equal(settlementNonce(RID).length, 8);
  assert.equal(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x5f))));
  assert.notEqual(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x60))));
});

// PICK A (2026-09-14): THE FEE LOCKS PAY THE SITTING SIGNER NODES, by §22A's weights.
const SIGNER_NODE = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const contractOf = (nodes) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes,
});
const feeLockFor = (e, n, amountMsat = FEE) =>
  [toHex(e.pubkey), { outpoint: { txid: b32(0x80 + n), outIdx: BigInt(n) }, amountMsat, preimage: b32(0xf0 + n) }];

test('every counted entry\'s fee lock (5% of its stake) is claimed in the same settlement and the two sitting signer nodes are paid by §22A\'s weights - winners\' fee locks too, a VOID entry\'s not', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const V = entry(3, VOID, 0);
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const s = lockSettlement({ roundId: RID, entries: [W, L, V], minScore: 1, fees: NO_FEES, contract: contractOf(signerNodes),
    signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, addressed: named(W),
    locks: new Map([lockFor(W, 1), lockFor(L, 2), lockFor(V, 3)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2), feeLockFor(V, 3)]) });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.feeClaims.map((c) => toHex(c.pubkey)).sort(), [toHex(W.pubkey), toHex(L.pubkey)].sort(), 'the fee locks claimed are not exactly the counted entries\'');
  assert.equal(s.feePoolMsat, 2n * FEE, 'two counted entries at 5% of 100000');
  // two halves of the 5% on the 200000 gross, each signer node in both pools: half the fee of the two entries to each,
  // paid whole with no guardian fee
  const each = (2n * FEE) / 2n;
  assert.deepEqual(s.signerNodePayouts.map((p) => [toHex(p.payoutPk), p.owedMsat, p.msat]).sort(), signerNodes.map((k) => [toHex(refundKeyOf(k)), each, each]).sort());
  assert.equal(s.claims.length, 3, 'one stake lock and two fee locks in one transaction');
  assert.ok(s.payouts.some((p) => p.kind === 'qualifier'), 'the winner is still paid');
  assert.equal(s.feeHole, null);
});

// MEASURED: UNDER THE REAL GUARDIANS' RULE (1000 msat per input and output, stake-lock-step3.sh)
// A 2000 msat fee lock cannot reach a signer node - so it is not claimed, and the hole is named. Under the 5% fee (§0A.8,
//) that is the fee lock of a 40 sat stake: two such locks put 4000 msat in, and two inputs and two outputs at
// 1000 msat each take all of it. (100 sat rounds' 5000 msat locks pay: the gate below.)
const SMALL = 40000n;
const small = (n, outcome, score) => ({ ...entry(n, outcome, score), stakeMsat: SMALL, feeMsat: entryFeeMsat(SMALL) });
test('under the real guardians\' 1000 msat per input and output, 40 sat rounds\' 2000 msat fee locks cannot pay a signer node: none is claimed, each expires back, the hole is named in msat', () => {
  const W = small(1, DELIVERED, 3);
  const L = small(2, FAILED, 0);
  assert.equal(W.feeMsat, 2000n, 'a 40 sat stake\'s 5% fee lock');
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: { ppm: 0n, baseMsat: 1000n }, contract: contractOf(signerNodes),
    signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]),
    feeLocks: new Map([feeLockFor(W, 1, W.feeMsat), feeLockFor(L, 2, L.feeMsat)]), addressed: named(W) });
  console.log(`  real fee rule: fee claims ${s.feeClaims.length}; hole ${s.feeHole && `${s.feeHole.poolMsat} msat pool, ${s.feeHole.inputFeesMsat} input fees, ${s.feeHole.owedMsat} owed`}; `
    + `signer nodes owed ${s.unpaid.filter((u) => /fee share/.test(u.why)).map((u) => u.owedMsat).join(', ')}; the winner still paid ${s.payouts.filter((p) => p.kind === 'qualifier').map((p) => p.msat).join(', ')}`);
  assert.equal(s.ok, true, s.why);
  assert.equal(s.feeClaims.length, 0, 'fee locks were claimed that pay no signer node - the players\' fees would only pay the guardians');
  assert.deepEqual([s.feeHole.poolMsat, s.feeHole.inputFeesMsat, s.feeHole.owedMsat], [4000n, 2000n, 4000n]);
  assert.deepEqual(s.unpaid.filter((u) => /fee share/.test(u.why)).map((u) => u.owedMsat), [2000n, 2000n]);
  // the loser's net stake (38000) less the guardians' 1000 msat on its input and 1000 on the payout
  assert.deepEqual(s.payouts.map((p) => [p.kind, p.msat]), [['qualifier', SMALL - W.feeMsat - 2000n]], 'the stake part changed');
});

test('under a proportional fee rule each sitting signer node is paid its share of the fee locks, less its part of the guardians\' fees', () => {
  const players = [entry(1, DELIVERED, 900), entry(2, FAILED, 0), entry(3, FAILED, 0), entry(4, FORFEIT, 0)];
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const s = lockSettlement({ roundId: RID, entries: players, minScore: 1, fees: { ppm: 1000n, baseMsat: 0n }, contract: contractOf(signerNodes),
    signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, locks: new Map(players.map((e, i) => lockFor(e, i + 1))),
    feeLocks: new Map(players.map((e, i) => feeLockFor(e, i + 1))) });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.feePoolMsat, 4n * FEE);
  assert.equal(s.signerNodePayouts.length, 2);
  // each signer node is in both pools: 2.5% + 2.5% of 400000, halved; its part of the four fee locks' input fees is half
  const owed = (4n * FEE) / 2n, inputPart = (4n * lnv2FeeMsat({ ppm: 1000n, baseMsat: 0n }, FEE)) / 2n;
  for (const p of s.signerNodePayouts) {
    assert.equal(p.owedMsat, owed, 'each signer node is in both pools: 2.5% + 2.5% of 400000, halved');
    assert.ok(p.msat + p.feeMsat <= owed - inputPart, `a signer node took more than its share less its part of the input fees: ${p.msat}+${p.feeMsat}`);
  }
  assert.equal(s.feeInputFeesMsat + s.feePaidMsat + s.feeOutputFeesMsat + s.feeUnspentMsat, s.feePoolMsat);
  console.log(`  proportional: fee pool ${s.feePoolMsat}, input fees ${s.feeInputFeesMsat}, signer nodes ${s.signerNodePayouts.map((p) => `${p.msat}+${p.feeMsat}`).join(', ')}, unspent ${s.feeUnspentMsat}`);
});

test('a round with losers and no qualifier still claims its fee locks for the signer nodes, and claims no stake', () => {
  const L1 = entry(1, FAILED, 0);
  const L2 = entry(2, FORFEIT, 0);
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const s = lockSettlement({ roundId: RID, entries: [L1, L2], minScore: 1, fees: NO_FEES, contract: contractOf(signerNodes),
    signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, locks: new Map([lockFor(L1, 1), lockFor(L2, 2)]),
    feeLocks: new Map([feeLockFor(L1, 1), feeLockFor(L2, 2)]) });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.claims.every((c) => c.kind === 'fee'), true, 'a stake was claimed with nobody to pay');
  assert.match(s.stakeWhy, /operator would keep/);
  assert.deepEqual(s.signerNodePayouts.map((p) => p.msat).sort(), [(2n * FEE) / 2n, (2n * FEE) / 2n]);
});

test('a counted entry with no verified fee lock, a fee lock of another amount, or no signer nodes named: nothing is claimed', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const base = { roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, contract: contractOf(signerNodes), locks: new Map([lockFor(W, 1), lockFor(L, 2)]) };
  const missing = lockSettlement({ ...base, signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, feeLocks: new Map([feeLockFor(W, 1)]) });
  assert.match(missing.why, /fee lock was never verified/);
  const wrong = lockSettlement({ ...base, signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2, FEE - 1n)]) });
  assert.match(wrong.why, new RegExp(`fee lock holds ${FEE - 1n} msat and its entry's fee is ${FEE}`));
  const noSignerNodes = lockSettlement({ ...base, feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  assert.match(noSignerNodes.why, /no contract or signer nodes were named/);
});

// PICK (b) (2026-09-14): THE GATE - A FEE LOCK IS MINTED ONLY WHEN IT CAN PAY A SIGNER NODE.
const REAL_RULE = { ppm: 0n, baseMsat: 1000n };   // measured on fedimintd 0.12.0 (stake-lock-step3.sh)
const at = (stakeMsat) => ({ ...contractOf([SIGNER_NODE(1), SIGNER_NODE(2)]), stakeMsat });
const show = (g) => `stake ${g.stakeMsat} msat, lock ${g.lockMsat}, ${g.players} players, ${g.signerNodes} signer nodes, input fees ${g.inputFeesMsat}, `
  + `output fees ${g.outputFeesMsat}, per-signer node net [${(g.perSignerNodeNetMsat || []).join(', ')}], unpaid ${g.unpaidSignerNodes} - ${g.pays ? 'MINT' : 'NO LOCK'}: ${g.why}`;

test('the gate: a 40 sat round with two players mints no fee lock - its 2000 msat lock (5%) would only pay the federation', () => {
  const g = feeLockPays({ contract: at(SMALL), fees: REAL_RULE });
  console.log(`  40 sat: ${show(g)}`);
  assert.equal(g.pays, false);
  assert.equal(g.lockMsat, entryFeeMsat(SMALL));
  assert.equal(g.lockMsat, 2000n);
  // and a 100 sat round's 5000 msat lock does pay its two signer nodes
  assert.equal(feeLockPays({ contract: at(STAKE), fees: REAL_RULE }).pays, true);
});

test('the gate: a 1000 sat round mints its 50000 msat fee lock (5%), and every sitting signer node nets more than nothing after 1000 msat per input and per output', () => {
  const g = feeLockPays({ contract: at(1000000n), fees: REAL_RULE });
  console.log(`  1000 sat: ${show(g)}`);
  assert.equal(g.pays, true, g.why);
  assert.equal(g.lockMsat, entryFeeMsat(1000000n));
  // THE ROUND'S SITTING SIGNER NODES (2026-09-15 07:42): a 2-of-2 pays its two signer nodes, each both pools' shares.
  assert.equal(g.signerNodes, 2, 'the round\'s two sitting signer nodes, not one signer node per slot');
  assert.equal(g.perSignerNodeNetMsat.length, 2, 'one payout per sitting signer node - a signer node in both pools is paid both shares together');
  for (const net of g.perSignerNodeNetMsat) assert.ok(net > 0n, `a signer node nets ${net}`);
  assert.equal(g.inputFeesMsat, 2000n, 'two fee locks in, 1000 msat each');
  assert.equal(g.outputFeesMsat, 2000n, 'two signer node payouts out, 1000 msat each');
});

test('the gate sizes the fee for the signer nodes the settlement pays: a 5-of-7 its seven, a 2-of-2 its two - never a signer node per slot', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7].map(SIGNER_NODE);
  const g7 = feeLockPays({ contract: { ...contractOf(seven), stakeMsat: 1000000n }, fees: REAL_RULE });
  console.log(`  5-of-7, 1000 sat: ${show(g7)}`);
  assert.equal(g7.signerNodes, 7);
  assert.equal(g7.perSignerNodeNetMsat.length, 7);
  // THE SAME SIGNER NODES AS THE SETTLEMENT: the signer nodes' own plan over the same two players pays exactly these nets.
  const two = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const g2 = feeLockPays({ contract: at(1000000n), fees: REAL_RULE });
  // two 1000 sat players - the gate's worst case at this stake: the net staked, the 5% fee each
  const BIG = 1000000n, BIG_FEE = entryFeeMsat(BIG);
  const W = { ...entry(1, DELIVERED, 3), stakeMsat: BIG, feeMsat: BIG_FEE };
  const L = { ...entry(2, FAILED, 0), stakeMsat: BIG, feeMsat: BIG_FEE };
  const plan = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: REAL_RULE, contract: { ...contractOf(two), stakeMsat: BIG },
    locks: new Map([lockFor(W, 1), lockFor(L, 2)]), signerNodes: { gameVerify: two, settlement: two },
    feeLocks: new Map([feeLockFor(W, 1, BIG_FEE), feeLockFor(L, 2, BIG_FEE)]) });
  console.log(`  2-of-2 settlement over the same signer nodes: ${plan.ok ? `signer node payouts [${plan.signerNodePayouts.map((p) => p.msat).join(', ')}]` : plan.why}`);
  assert.equal(plan.ok, true, plan.why);
  assert.equal(plan.signerNodePayouts.length, g2.perSignerNodeNetMsat.length, 'the gate counted other signer nodes than the settlement pays');
  // AND A ROUND THAT NAMES NO SIGNER NODES MINTS NOTHING: there is nobody to pay.
  const none = feeLockPays({ contract: { ...at(1000000n), nodes: [] }, fees: REAL_RULE });
  assert.equal(none.pays, false);
  assert.match(none.why, /names no sitting signer nodes/);
});

test('the gate\'s floor, measured: the smallest stake it mints for, and 100 sat the smallest bracket (10 / 100 / 1000 sat) above it (5%)', () => {
  let lo = 1000n; let hi = 1000000n;   // 1 sat fails, 1000 sat passes (above)
  assert.equal(feeLockPays({ contract: at(lo), fees: REAL_RULE }).pays, false);
  while (hi - lo > 1000n) { const mid = ((lo + hi) / 2n / 1000n) * 1000n; if (feeLockPays({ contract: at(mid), fees: REAL_RULE }).pays) hi = mid; else lo = mid; }
  const floor = feeLockPays({ contract: at(hi), fees: REAL_RULE });
  console.log(`  the floor: ${hi / 1000n} sat mints (${show(floor)}); ${lo / 1000n} sat does not`);
  assert.equal(floor.pays, true);
  const brackets = [10000n, 100000n, 1000000n].map((s) => [s / 1000n, feeLockPays({ contract: at(s), fees: REAL_RULE }).pays]);
  console.log(`  brackets: ${brackets.map(([s, p]) => `${s} sat ${p ? 'mints' : 'no lock'}`).join(', ')}`);
  // under 5% the floor is just above 40 sat (two locks must out-weigh 4000 msat of input and output fees): 10 sat mints
  // nothing, 100 and 1000 sat mint
  assert.deepEqual(brackets.map(([, p]) => p), [false, true, true]);
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
  assert.match(s.why, new RegExp(`operator would keep ${2n * NET} msat: a pool of ${2n * NET} against 0 handed out`));
});

// THE POOL (RULED 2026-09-23, (ii) with (iii) - never (i)). Only a qualifier who named a Lightning address is paid;
// an unaddressed qualifier's share is split over the addressed ones by the table's own weights renormalised over that
// set, the dust to the first addressed row of the table; with nobody addressed no stake lock is claimed.
const POOL_FEES = { ppm: 0n, baseMsat: 1000n };   // the guardians' measured rule
const nineAndThree = () => {
  const qualifiers = [900, 800, 700, 600, 500, 400, 300, 200, 100].map((score, i) => entry(i + 1, DELIVERED, score));
  const losers = [10, 11, 12].map((n) => entry(n, FAILED, 0));
  return { qualifiers, losers, all: [...qualifiers, ...losers] };
};

test('WINNINGS-AUTO A (RULED 2026-10-01): no qualifier named anything - every qualifier of a paying rank is paid once, by a payout contract to its own key; payouts and fees are the whole claimed pot', () => {
  const { qualifiers, all } = nineAndThree();
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const s = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees: POOL_FEES });
  assert.equal(s.ok, true, s.why);
  console.log(`  A: pool ${s.poolMsat}, input fees ${s.inputFeesMsat}; paid ${s.payouts.map((p) => `${toHex(p.pubkey).slice(0, 4)} ${p.msat}+${p.feeMsat}`).join(', ')}`);
  assert.ok(s.payouts.length >= 3, 'the paying ranks were not paid');
  assert.deepEqual(s.unpaid, [], 'a qualifier was pooled for want of an address');
  assert.equal(new Set(s.payouts.map((p) => toHex(p.pubkey))).size, s.payouts.length, 'a qualifier was paid twice');
  for (const p of s.payouts) {
    assert.equal(p.kind, 'qualifier', 'a winner was paid by something other than its payout contract');
    const q = qualifiers.find((x) => toHex(x.pubkey) === toHex(p.pubkey));
    assert.equal(toHex(p.payoutPk), toHex(locks.get(toHex(q.pubkey)).refundPk), 'a payout contract is not to the qualifier\'s own key');
  }
  assert.equal(s.inputFeesMsat + s.paidMsat + s.outputFeesMsat, s.poolMsat, 'the payouts and fees are not the claimed pot');
  assert.equal(s.unspentMsat, 0n, 'a remainder was left for the guardians');
});

test('WINNINGS-AUTO B: a winner who named no address is paid all the same - the loser\'s stake lock is claimed, the winner\'s contract built; the fee locks settle', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, contract: contractOf(signerNodes),
    signerNodes: { gameVerify: signerNodes, settlement: signerNodes }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]),
    feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  assert.equal(s.ok, true, s.why);
  console.log(`  B: stake claims ${s.claims.filter((c) => c.kind === 'stake').length}, qualifier payouts ${s.payouts.filter((p) => p.kind === 'qualifier').length}, fee claims ${s.feeClaims.length}`);
  assert.equal(s.claims.filter((c) => c.kind === 'stake').length, 1, 'the loser\'s stake lock was not claimed');
  const won = s.payouts.filter((p) => p.kind === 'qualifier');
  assert.equal(won.length, 1);
  assert.equal(toHex(won[0].pubkey), toHex(W.pubkey));
  assert.equal(s.feeClaims.length, 2);
});

test('WINNINGS-AUTO C: an address or a planned send changes nothing - never a send, never a contract refunding to the committee, the same amounts', () => {
  const { qualifiers, all } = nineAndThree();
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const base = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees: POOL_FEES });
  const COMMITTEE = refund(0xcc);
  const sends = new Map(base.payouts.map((p, i) => [toHex(p.pubkey), { paymentHash: toHex(b32(0x70 + i)), gatewayPk: toHex(refund(0x6a)).slice(2),
    refundPk: COMMITTEE, expiration: 3000n }]));
  const s = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees: POOL_FEES, addressed: named(qualifiers[0]), sends, requireSends: true });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.payouts.map((p) => p.kind), base.payouts.map(() => 'qualifier'), 'a qualifier was paid by a Lightning send');
  for (const p of s.payouts) assert.notEqual(toHex(p.payoutPk), toHex(COMMITTEE));
  assert.deepEqual(s.payouts.map((p) => [toHex(p.pubkey), p.msat]).sort(), base.payouts.map((p) => [toHex(p.pubkey), p.msat]).sort(), 'an address changed an amount');
});

// THE SECOND SETTLEMENT OF A LATE LOSER (§13A, RULED 2026-09-24, slice C3b-1). An entry left out of the round's
// settlement while still in its re-run window, which then ends FINAL and FAILED, or FORFEIT, is claimed in its own
// transaction. Its lock's net stake, less that transaction's own guardian fees, goes to the winners the first
// transaction paid, each by its first payout's fraction of the first pool, integer msat, the dust to the first row in
// the first table's order - and nobody already paid is reduced. Its fee lock, where minted, pays the signer nodes, not
// the pool. VOID and a late qualifier are never claimed; a first table that paid nobody claims nothing.
test('a late FAILED or FORFEIT lock is claimed alone and its net stake, less the fees, is split by the first table\'s shares', async () => {
  const { lateLockSettlement, lateSettlementNonce } = await import('../src/lock-settlement.js');
  const A = entry(1, DELIVERED, 3); const B = entry(2, DELIVERED, 2);
  const first = lockSettlement({ roundId: RID, entries: [A, B, entry(3, FAILED, 0), entry(4, FAILED, 0)], minScore: 1, fees: { ppm: 0n, baseMsat: 1000n },
    locks: new Map([lockFor(A, 1), lockFor(B, 2), lockFor(entry(3, FAILED, 0), 3), lockFor(entry(4, FAILED, 0), 4)]), addressed: named(A, B) });
  assert.equal(first.ok, true, first.why);
  // THE FIRST PLAN'S SHARES are exactly what it paid each winner.
  assert.deepEqual(first.stakeShares.map((x) => [toHex(x.pubkey), x.msat]),
    first.payouts.filter((p) => p.kind === 'qualifier').map((p) => [toHex(p.pubkey), p.msat]));
  // TWO PAID WINNERS, in the first table's order, to show the split and where the dust goes.
  const shares = [{ pubkey: A.pubkey, msat: 60001n }, { pubkey: B.pubkey, msat: 35999n }];
  const winnerLocks = new Map([lockFor(A, 1), lockFor(B, 2)]);
  const LATE = b32(0x77);
  for (const outcome of [FAILED, FORFEIT]) {
    const L = entry(9, outcome, 0);
    const s = lateLockSettlement({ roundId: RID, entryId: LATE, entry: L, lock: lockFor(L, 9)[1], shares, winnerLocks, fees: { ppm: 0n, baseMsat: 1000n } });
    assert.equal(s.ok, true, s.why);
    assert.deepEqual(s.claims.map((c) => [toHex(c.pubkey), c.amountMsat, c.kind]), [[toHex(L.pubkey), NET, 'stake']]);
    const weight = shares.reduce((t, x) => t + x.msat, 0n);
    const spendable = NET - 1000n;
    const want = shares.map((x) => largestPayoutMsat({ ppm: 0n, baseMsat: 1000n }, (x.msat * spendable) / weight));
    const dust = spendable - want.reduce((t, m) => t + m + 1000n, 0n);
    want[0] = largestPayoutMsat({ ppm: 0n, baseMsat: 1000n }, want[0] + 1000n + dust);
    const byKey = new Map(s.payouts.map((p) => [toHex(p.pubkey), p]));
    assert.deepEqual(shares.map((x) => byKey.get(toHex(x.pubkey)).msat), want);
    assert.deepEqual(shares.map((x) => toHex(byKey.get(toHex(x.pubkey)).payoutPk)), [toHex(refund(1)), toHex(refund(2))], 'not paid by a contract to the winner\'s own key');
    assert.equal(s.paidMsat + s.outputFeesMsat + s.inputFeesMsat, NET, 'the late stake is not wholly accounted for');
    assert.equal(toHex(s.nonce), toHex(lateSettlementNonce(RID, LATE)));
    assert.notEqual(toHex(s.nonce), toHex(settlementNonce(RID)), 'the second transaction reuses the round\'s nonce');
  }
});

test('a late VOID or qualifier is never claimed, a first table that paid nobody claims nothing, and a late fee lock pays the signer nodes, not the pool', async () => {
  const { lateLockSettlement } = await import('../src/lock-settlement.js');
  const A = entry(1, DELIVERED, 3);
  const shares = [{ pubkey: A.pubkey, msat: NET }];
  const winnerLocks = new Map([lockFor(A, 1)]);
  const ask = (L, over = {}) => lateLockSettlement({ roundId: RID, entryId: b32(0x77), entry: L, lock: lockFor(L, 9)[1], shares, winnerLocks, fees: NO_FEES, ...over });
  assert.match(ask(entry(9, VOID, 0)).why, /^a late VOID is not claimed: nothing acts, and the lock returns to its player at its expiry$/);
  assert.match(ask(entry(9, DELIVERED, 3)).why, /^a late DELIVERED run is not claimed: a qualifier's stake comes back by its own forfeit - stake back only, no share$/);
  assert.match(ask(entry(9, FAILED, 0), { shares: [] }).why, /^the first settlement paid nobody, so the late lock is not claimed: it returns to its player at its expiry$/);
  assert.match(ask(entry(9, FAILED, 0), { lock: lockFor(entry(9, FAILED, 0), 9, NET - 1000n)[1] }).why, new RegExp(`holds ${NET - 1000n} msat and its entry's net stake is ${NET}`));
  // THE FEE LOCK, WHERE MINTED: claimed in the same transaction and paid to the sitting signer nodes - the winner's amount unchanged.
  const signerNodes = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const L = entry(9, FAILED, 0);
  const plain = ask(L);
  const withFee = ask(L, { feeLock: feeLockFor(L, 9)[1], contract: contractOf(signerNodes), signerNodes: { gameVerify: signerNodes, settlement: signerNodes } });
  assert.equal(withFee.ok, true, withFee.why);
  assert.deepEqual(withFee.claims.map((c) => c.kind).sort(), ['fee', 'stake']);
  assert.deepEqual(withFee.payouts.filter((p) => p.kind === 'qualifier').map((p) => p.msat), plain.payouts.map((p) => p.msat));
  // one late entry's fee lock (5% of 100000) over the two sitting signer nodes, each in both pools: half each
  assert.deepEqual(withFee.signerNodePayouts.map((p) => p.msat), [FEE / 2n, FEE - FEE / 2n]);
});

// WINNINGS-AUTO (RULED 2026-10-01; C3b-2a withdrawn): a late share is never sent. Send plans handed in - even with
// requireSends, even for another amount - change nothing: each winner's late share is the payout contract to its own lock
// refund key, exactly the plan built without them.
test('WINNINGS-AUTO: with send plans handed in, a late payout is still the contract to the winner\'s own key - the same plan as without', async () => {
  const { lateLockSettlement } = await import('../src/lock-settlement.js');
  const A = entry(1, DELIVERED, 3); const B = entry(2, DELIVERED, 2);
  const shares = [{ pubkey: A.pubkey, msat: 60001n }, { pubkey: B.pubkey, msat: 35999n }];
  const FEES = { ppm: 0n, baseMsat: 1000n };
  const L = entry(9, FAILED, 0);
  const COMMITTEE = refund(0xcc);
  const winnerLocks = new Map([lockFor(A, 1), lockFor(B, 2)]);
  const args = { roundId: RID, entryId: b32(0x77), entry: L, lock: lockFor(L, 9)[1], shares, winnerLocks, fees: FEES };
  const base = lateLockSettlement(args);
  assert.equal(base.ok, true, base.why);
  const sends = new Map(base.payouts.filter((p) => p.kind === 'qualifier').map((p) => [toHex(p.pubkey), { paymentHash: toHex(b32(p.pubkey[0] + 0x20)),
    gatewayPk: '02' + 'ab'.repeat(32), refundPk: COMMITTEE, expiration: 1500n, payoutMsat: p.msat + 1n }]));
  const withSends = lateLockSettlement({ ...args, sends, requireSends: true });
  assert.equal(withSends.ok, true, withSends.why);
  const plan = (s) => JSON.stringify(s.payouts.map((p) => [p.kind, toHex(p.payoutPk), String(p.msat), !!p.sent]));
  assert.equal(plan(withSends), plan(base), 'send plans changed the late settlement');
  for (const p of base.payouts.filter((x) => x.kind === 'qualifier')) {
    assert.ok(!p.sent, 'a late share was sent');
    assert.equal(toHex(p.payoutPk), toHex(winnerLocks.get(toHex(p.pubkey)).refundPk), 'a late share is not a contract to the winner\'s own key');
  }
});

// A GUARDIAN IS PAID AT ITS ADVERT'S PAYOUT KEY (2026.0.13, gap 2; §22A v4.6.4): the seat names it per guardian
// (signerNodes.guardianPayout); a guardian with none - a placeholder key, or out of the census - is paid at its node key as before.
test('a 2026.0.13 guardian share goes to the guardian\'s payout key, its own output; one without a key at its node key', async () => {
  const { guardianPayoutKeyOf, onCurveX, isPlaceholderKey } = await import('../src/guardian-payout.js');
  const GX = Uint8Array.from(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));   // the generator's x
  assert.equal(onCurveX(GX), true);
  assert.equal(isPlaceholderKey(new Uint8Array(32).fill(3)), true);
  assert.equal(guardianPayoutKeyOf(new Uint8Array(32).fill(3)), null, 'the live adverts\' placeholder: no payout key');
  assert.equal(guardianPayoutKeyOf(new Uint8Array(32).fill(0xff)), null, 'an x past the field: no key');
  assert.equal(toHex(guardianPayoutKeyOf(GX)), '02' + toHex(GX));
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const committee = [SIGNER_NODE(1), SIGNER_NODE(2)];
  const g1 = SIGNER_NODE(7), g2 = SIGNER_NODE(8);
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, contract: contractOf(committee),
    signerNodes: { gameVerify: committee, settlement: committee, guardian: [g1, g2], guardianPayout: new Map([[toHex(g1), guardianPayoutKeyOf(GX)]]) },
    addressed: named(W), locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  assert.equal(s.ok, true, s.why);
  const byKey = new Map(s.signerNodePayouts.map((p) => [toHex(p.payoutPk), p]));
  const third = (2n * FEE) - 2n * ((2n * FEE) / 3n);
  assert.equal(byKey.get('02' + toHex(GX)).kind, 'guardian payout key', 'g1 at its payout key');
  assert.equal(byKey.get('02' + toHex(GX)).owedMsat, third / 2n);
  assert.equal(byKey.get(toHex(refundKeyOf(g2))).owedMsat, third / 2n, 'g2 (no payout key) at its node key');
  assert.equal(byKey.has(toHex(refundKeyOf(g1))), false, 'nothing of g1\'s guardian share at its node key');
  const total = s.signerNodePayouts.reduce((a, p) => a + p.owedMsat, 0n);
  assert.equal(total, 2n * FEE, 'the whole fee, as before');
});
