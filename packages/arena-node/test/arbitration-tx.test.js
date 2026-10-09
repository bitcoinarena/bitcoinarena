// THE ARBITRATION TRANSACTION, BUILT (§5A.3B; M4 in the repo only). Offline: the builder's arithmetic, the commitment
// and the refusals. The consensus answers are tools/arbitration-regtest.mjs's, against bitcoind on a private regtest
// (2026-09-29): 5 of 7 allowed; 4 of 7 "false/empty top stack element"; slash_height above the tip "non-final"; an
// output moved after signing "Invalid Schnorr signature"; mined with nLockTime = the committed height; the players'
// escrow spent by 5 of 7 allowed and by 4 of 7 refused. The escrow script it paid is pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { tapLeafHash, slashLeaf } from '../../arena-protocol/src/bond-script.js';
import {
  escrowOutput, arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, arbitrationCommitment,
  arbitrationCommitmentIn,
} from '../../arena-protocol/src/arbitration-tx.js';
import { spendCommitsTo } from '../../arena-protocol/src/bond-spend.js';
import { slashDistribution } from '../../arena-protocol/src/slash.js';
import { toHex, taggedHash, fromHex } from '../../arena-protocol/src/hash.js';

const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let s = null;
  for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); s = s === null ? p : s.add(p); }
  return schnorr.utils.pointToBytes(s);
};
const g = genesisFor('regtest');
const key = (n) => schnorr.getPublicKey(taggedHash('ARENA/v1/ArbProbe', Uint8Array.from([n])));
const proofId = taggedHash('ARENA/v1/SlashProof', fromHex('cd'.repeat(32)));
const bond = { txid: new Uint8Array(32).fill(0x11), vout: 0, value: 100000000n, script: fromHex(`5120${'22'.repeat(32)}`) };
const escrow = escrowOutput({ arbitrationKeys: g.arbitrationKeys, k: g.arbitrationK }, { tweakPoint, combine });
const NODES = fromHex(`0014${'33'.repeat(20)}`), DEVS = fromHex(`0014${'44'.repeat(20)}`);
const dist = (affected = [key(1), key(2)]) => slashDistribution({ bondSats: bond.value, roundId: new Uint8Array(32).fill(7),
  contract: { slashRemainder: 'SPLIT' }, affectedPlayers: affected, censusNodes: [key(10), key(11), key(12), key(13)], seats: [key(10)] });

test('the players\' escrow is the arbitration set\'s k-of-m leaf - the script bitcoind took and the set spent on regtest', () => {
  assert.equal(toHex(escrow.script), '5120bfe44ec5e680e0460f1d4322690f15f4af14ddaa77234eeaad17d2aad16cb89a');
  assert.equal(toHex(escrow.leafScript), toHex(slashLeaf(g.arbitrationKeys, g.arbitrationK)));
});

test('three outputs and the commitment, nLockTime = slash_height, the amounts slash.js hands out, the fee off the nodes and never the players', () => {
  const built = arbitrationSpend({ bond, proofId, slashHeight: 104, hint: new TextEncoder().encode('blwp'), distribution: dist(),
    escrowScript: escrow.script, nodesScript: NODES, developersScript: DEVS, feeSats: 3000n });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.tx.locktime, 104);
  assert.ok(built.tx.inputs[0].sequence < 0xffffffff, 'a final sequence would switch nLockTime off');
  assert.deepEqual(built.tx.outputs.map((o) => [o.pays || 'commitment', String(o.value)]),
    [['commitment', '0'], ['players\' escrow', '50000000'], ['nodes\'', '37497000'], ['developers\'', '12500000']]);
  assert.equal(built.tx.outputs.reduce((s, o) => s + o.value, 0n) + 3000n, bond.value);
  const read = arbitrationCommitmentIn(built.tx.outputs);
  assert.deepEqual([toHex(read.proofId), read.slashHeight, new TextDecoder().decode(read.hint)], [toHex(proofId), 104, 'blwp']);
  assert.equal(spendCommitsTo(built.tx.outputs, proofId).ok, true, 'bond-spend.js reads the same proof id');
  // A FEE LARGER THAN THE NODES' OUTPUT is taken on from the developers', and one larger than both is refused.
  const big = arbitrationSpend({ bond, proofId, slashHeight: 104, distribution: dist(), escrowScript: escrow.script,
    nodesScript: NODES, developersScript: DEVS, feeSats: 37500000n + 1000n });
  assert.deepEqual([String(big.fee.fromNodes), String(big.fee.fromDevelopers), String(big.amounts.players)], ['37500000', '1000', '50000000']);
  assert.equal(arbitrationSpend({ bond, proofId, slashHeight: 104, distribution: dist(), escrowScript: escrow.script,
    nodesScript: NODES, developersScript: DEVS, feeSats: 50000001n }).ok, false);
});

test('with nobody affected there is no players\' output: that half is the pool\'s, 75/25 to the nodes and the developers', () => {
  const built = arbitrationSpend({ bond, proofId, slashHeight: 104, distribution: dist([]), escrowScript: escrow.script,
    nodesScript: NODES, developersScript: DEVS, feeSats: 0n });
  assert.equal(built.ok, true, built.why);
  assert.deepEqual(built.tx.outputs.map((o) => [o.pays || 'commitment', String(o.value)]),
    [['commitment', '0'], ['nodes\'', '75000000'], ['developers\'', '25000000']]);
});

test('the witness: fewer than k signatures refused by name; k gives one item per sorted key, the script and the control block', () => {
  const built = arbitrationSpend({ bond, proofId, slashHeight: 104, distribution: dist(), escrowScript: escrow.script,
    nodesScript: NODES, developersScript: DEVS, feeSats: 3000n });
  const h = arbitrationSighash(built, tapLeafHash(slashLeaf(g.arbitrationKeys, g.arbitrationK)));
  const secrets = Array.from({ length: g.arbitrationM }, (_, i) => taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`)));
  const sigs = (n) => new Map(secrets.slice(0, n).map((s) => [toHex(schnorr.getPublicKey(s)), schnorr.sign(h, s)]));
  const control = new Uint8Array(65).fill(0xc0);
  const short = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: g.arbitrationK, signatures: sigs(g.arbitrationK - 1), controlBlock: control });
  assert.equal(short.ok, false);
  assert.match(short.why, /4 of the 5 arbitration signatures/);
  const w = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: g.arbitrationK, signatures: sigs(g.arbitrationK), controlBlock: control });
  assert.equal(w.ok, true);
  assert.equal(w.witness.length, g.arbitrationM + 2);
  assert.equal(w.witness.filter((x) => x.length === 64).length, g.arbitrationK);
  assert.ok(arbitrationTransaction(built, w.witness).length > 400);
});

test('the commitment refuses what it cannot carry: a proof id that is not 32 bytes, a height that is a time, more than 80 bytes', () => {
  assert.throws(() => arbitrationCommitment(new Uint8Array(31), 1));
  assert.throws(() => arbitrationCommitment(proofId, 500000000));
  assert.throws(() => arbitrationCommitment(proofId, 1, new Uint8Array(45)));
  assert.equal(arbitrationCommitment(proofId, 1, new Uint8Array(44)).script.length, 2 + 80);
});
