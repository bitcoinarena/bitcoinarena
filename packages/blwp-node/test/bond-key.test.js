// THE OUTPUT KEY, ON THE REAL CURVE.
//
// `bond-script.js` does the hashing and refuses to do the one point addition,
// because the protocol package carries no curve and must not: it is the one
// every other package reads. This is the caller that brings one - the same
// shape as the advertisement verifier - and it is where Q = P + t*G actually
// happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bondOutputKey, bondOutputKeyMatches, bondTapTree, recoveryLeaf, slashLeaf, tapLeafHash,
} from '../../protocol/src/bond-script.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { taggedHash, toHex } from '../../protocol/src/hash.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { recognizeBond } from '../../protocol/src/chain.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const big = (b) => BigInt('0x' + toHex(b));

/** BIP-341: Q = P + t*G, with P lifted from its x-only form. */
const tweakPoint = (internalKey, tweak) => {
  const P = schnorr.utils.lift_x(big(internalKey));
  const Q = P.add(secp256k1.Point.BASE.multiply(big(tweak)));
  return schnorr.utils.pointToBytes(Q);
};

const genesis = genesisFor('regtest');
const NODE = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const ARBITRATION = [1, 2, 3, 4, 5, 6, 7]
  .map(() => schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const INTERNAL = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const inputs = {
  nodeKey: NODE, arbitrationKeys: ARBITRATION, arbitrationK: genesis.arbitrationK,
  bondMaturity: genesis.bondMaturity, internalKey: INTERNAL,
};

/**
 * THE HASHING IS BIP-341'S, checked against another implementation of the same
 * construction rather than against itself. A tree that only agreed with its
 * own tagged hash would agree with nothing else on the network.
 */
test('the tagged hashes are the ones the curve library computes', () => {
  const script = recoveryLeaf(NODE, genesis.bondMaturity);
  const preimage = Uint8Array.from([0xc0, script.length, ...script]);

  assert.deepEqual(tapLeafHash(script), schnorr.utils.taggedHash('TapLeaf', preimage),
    'the leaf hash is not the TapLeaf tagged hash');
  assert.deepEqual(taggedHash('TapTweak', Uint8Array.from([...INTERNAL, ...b32(9)])),
    schnorr.utils.taggedHash('TapTweak', Uint8Array.from([...INTERNAL, ...b32(9)])));
});

/**
 * Q IS A POINT ON THE CURVE, and the same inputs give the same one.
 */
test('the output key is the taproot tweak of the named keys and maturity', () => {
  const built = bondOutputKey(inputs, { tweakPoint });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.outputKey.length, 32);

  // it is a real x-only key: it lifts
  assert.doesNotThrow(() => schnorr.utils.lift_x(big(built.outputKey)));

  // TWO NODES WITH THE SAME FACTS BUILD THE SAME BOND. Anything else and a
  // verifier could not tell a bond from a stranger's output.
  assert.deepEqual(bondOutputKey(inputs, { tweakPoint }).outputKey, built.outputKey);

  // AND IT IS NOT THE INTERNAL KEY. A tweak of zero would leave the arbitration
  // tree out of the output entirely.
  assert.notDeepEqual(built.outputKey, INTERNAL);
  assert.deepEqual(built.tweak, bondTapTree(inputs).tweak);
});

/**
 * THE RECOMPUTE REFUSES EVERY MOVED INPUT, on the real curve.
 */
test('a mutated key, maturity or leaf fails the recompute', () => {
  const built = bondOutputKey(inputs, { tweakPoint });
  assert.equal(bondOutputKeyMatches(built.outputKey, inputs, { tweakPoint }).ok, true);

  const moved = [
    ['the node key', { nodeKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()) }],
    ['the maturity', { bondMaturity: genesis.bondMaturity + 1 }],
    ['the quorum', { arbitrationK: 4 }],
    ['an arbitration key', {
      arbitrationKeys: [...ARBITRATION.slice(1), schnorr.getPublicKey(schnorr.utils.randomSecretKey())],
    }],
    ['the internal key', { internalKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()) }],
  ];
  for (const [what, over] of moved) {
    const seen = bondOutputKeyMatches(built.outputKey, { ...inputs, ...over }, { tweakPoint });
    assert.equal(seen.ok, false, `${what} did not move the output key`);
    assert.match(seen.why, /not the taproot tweak/);
  }

  // A STRANGER'S TAPROOT OUTPUT IS NOT A BOND. Any 32 bytes look like a P2TR
  // key on chain (25.1), which is exactly why recomputing is the only check.
  const stranger = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  assert.equal(bondOutputKeyMatches(stranger, inputs, { tweakPoint }).ok, false);

  // and the slash leaf really is the sorted five-of-seven the genesis names
  assert.equal(slashLeaf(ARBITRATION, genesis.arbitrationK)[0], 0x55);
  assert.equal(genesis.arbitrationM, ARBITRATION.length);
});

/**
 * AND A BOND POSTED WITH THAT KEY IS THE ONE THE CHAIN DOOR RECOGNISES, with
 * the output key now something a verifier can check rather than filler.
 */
test('a bond built with the template is recognised, and its key recomputes', () => {
  const built = bondOutputKey(inputs, { tweakPoint });
  const advert = {
    nodePubkey: NODE, operatorId: 'operator', protocolVersions: [1], roles: ['game'],
    endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
    settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
    bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3),
    timestamp: 1788700000000n,
  };
  const tx = parseTransaction(bondTransaction(advert, { outputKey: built.outputKey }));

  const seen = recognizeBond(tx, 0, advert);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.valueSats > 0n, true);

  // THE 32 BYTES ON CHAIN ARE THE ONES THE TEMPLATE PRODUCES.
  const onChain = tx.outputs[0].script.subarray(2, 34);
  assert.deepEqual(onChain, built.outputKey);
  assert.equal(bondOutputKeyMatches(onChain, inputs, { tweakPoint }).ok, true);
  assert.equal(onChain.every((b) => b === 0x77), false, 'the filler key is still being posted');

  // AND THE ONE THING LEFT UNCHECKED IS STILL NAMED. The chain door cannot
  // recompute for itself - it is handed no keys and no maturity - so it still
  // says so, and this test is what a caller holding them can do about it.
  assert.equal(seen.unchecked.some((u) => /script template/.test(u)), true);
});
