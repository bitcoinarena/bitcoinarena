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
  controlBlockFor, rootFromControlBlock, TAPLEAF_VERSION,
  bondInternalKey, aggregateKeys, keyAggCoefficients,
} from '../../protocol/src/bond-script.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { taggedHash, toHex } from '../../protocol/src/hash.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { recognizeBond } from '../../protocol/src/chain.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const big = (b) => BigInt('0x' + toHex(b));

/**
 * BIP-341: Q = P + t*G, with P lifted from its x-only form.
 *
 * The PARITY comes back with it. An output key is published x-only, which is
 * enough to recognise one and not enough to spend one: the control block's
 * first byte carries the y-parity, and a spender that guesses it has an invalid
 * witness half the time.
 */
const tweakPoint = (internalKey, tweak) => {
  const P = schnorr.utils.lift_x(big(internalKey));
  const Q = P.add(secp256k1.Point.BASE.multiply(big(tweak)));
  return {
    outputKey: schnorr.utils.pointToBytes(Q),
    parity: Number(Q.toAffine().y & 1n),
  };
};

const genesis = genesisFor('regtest');
const NODE = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const ARBITRATION = [1, 2, 3, 4, 5, 6, 7]
  .map(() => schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
/** BIP-327's sum: Q = sum a_i * P_i, with each key lifted from x-only. */
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const point = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? point : sum.add(point);
  }
  return schnorr.utils.pointToBytes(sum);
};

/**
 * THE INTERNAL KEY IS DERIVED FROM THE NAMED KEYS, not chosen. A fixture that
 * invented one would be testing a bond whose cooperative path belongs to
 * nobody in particular.
 */
const INTERNAL = bondInternalKey({ nodeKey: NODE, arbitrationKeys: ARBITRATION },
  { combine }).internalKey;
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
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.outputKey.length, 32);

  // it is a real x-only key: it lifts
  assert.doesNotThrow(() => schnorr.utils.lift_x(big(built.outputKey)));

  // TWO NODES WITH THE SAME FACTS BUILD THE SAME BOND. Anything else and a
  // verifier could not tell a bond from a stranger's output.
  assert.deepEqual(bondOutputKey(inputs, { tweakPoint, combine }).outputKey, built.outputKey);

  // AND IT IS NOT THE INTERNAL KEY. A tweak of zero would leave the arbitration
  // tree out of the output entirely.
  assert.notDeepEqual(built.outputKey, INTERNAL);
  assert.deepEqual(built.tweak, bondTapTree(inputs).tweak);
});

/**
 * THE RECOMPUTE REFUSES EVERY MOVED INPUT, on the real curve.
 */
test('a mutated key, maturity or leaf fails the recompute', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(bondOutputKeyMatches(built.outputKey, inputs, { tweakPoint, combine }).ok, true);

  const moved = [
    ['the node key', { nodeKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()) }],
    ['the maturity', { bondMaturity: genesis.bondMaturity + 1 }],
    ['the quorum', { arbitrationK: 4 }],
    ['an arbitration key', {
      arbitrationKeys: [...ARBITRATION.slice(1), schnorr.getPublicKey(schnorr.utils.randomSecretKey())],
    }],
  ];
  for (const [what, over] of moved) {
    // The internal key is RE-DERIVED for each: it is a function of the node
    // and arbitration keys, so a case that carried the old one would be
    // refused by the aggregate check and never reach the tweak at all.
    const withKeys = { ...inputs, ...over };
    const derived = bondInternalKey(withKeys, { combine });
    const seen = bondOutputKeyMatches(built.outputKey,
      { ...withKeys, internalKey: derived.ok ? derived.internalKey : withKeys.internalKey },
      { tweakPoint, combine });
    assert.equal(seen.ok, false, `${what} did not move the output key`);
    assert.match(seen.why, /not the taproot tweak/);
  }

  // AND A CHOSEN INTERNAL KEY IS REFUSED EARLIER AND HARDER - a different
  // mistake, and the more serious one.
  const chosen = bondOutputKeyMatches(built.outputKey,
    { ...inputs, internalKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()) },
    { tweakPoint, combine });
  assert.equal(chosen.ok, false);
  assert.match(chosen.why, /not the MuSig2 aggregate/);

  // A STRANGER'S TAPROOT OUTPUT IS NOT A BOND. Any 32 bytes look like a P2TR
  // key on chain (25.1), which is exactly why recomputing is the only check.
  const stranger = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  assert.equal(bondOutputKeyMatches(stranger, inputs, { tweakPoint, combine }).ok, false);

  // and the slash leaf really is the sorted five-of-seven the genesis names,
  // in tapscript's counting form: keys first, the quorum compared at the end.
  const leaf = slashLeaf(ARBITRATION, genesis.arbitrationK);
  assert.equal(leaf[0], 0x20, 'the leaf does not start with a key');
  assert.equal(leaf[leaf.length - 2], 0x50 + genesis.arbitrationK, 'the quorum is not k');
  assert.equal(leaf[leaf.length - 1], 0x9c, 'NUMEQUAL');
  assert.equal(genesis.arbitrationM, ARBITRATION.length);
});

/**
 * AND A BOND POSTED WITH THAT KEY IS THE ONE THE CHAIN DOOR RECOGNISES, with
 * the output key now something a verifier can check rather than filler.
 */
test('a bond built with the template is recognised, and its key recomputes', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
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
  assert.equal(bondOutputKeyMatches(onChain, inputs, { tweakPoint, combine }).ok, true);
  assert.equal(onChain.every((b) => b === 0x77), false, 'the filler key is still being posted');

  // AND THE ONE THING LEFT UNCHECKED IS STILL NAMED. The chain door cannot
  // recompute for itself - it is handed no keys and no maturity - so it still
  // says so, and this test is what a caller holding them can do about it.
  assert.equal(seen.unchecked.some((u) => /script template/.test(u)), true);
});

/**
 * THE CONTROL BLOCK REBUILDS THE VERY KEY THAT IS ON CHAIN.
 *
 * This is the check a spender's witness has to pass, done on the real curve:
 * take the leaf, take the control block, rebuild the root, tweak the internal
 * key by it, and see whether the point that comes out is the output the bond
 * was posted to. A control block that did not is a leaf that cannot spend.
 */
test('both leaves reconstruct the on-chain output key from their control block', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);

  // THE PARITY IS INFORMATION THE 32 BYTES DO NOT CARRY. `lift_x` always
  // returns the EVEN point for an x-only key, so a spender that read the
  // output off the chain and lifted it would believe the parity is always 0 -
  // and be wrong whenever the real Q is odd. That is why the curve is asked
  // and the answer is kept.
  assert.equal(Number(schnorr.utils.lift_x(big(built.outputKey)).toAffine().y & 1n), 0,
    'lift_x no longer returns the even point, so this argument needs remaking');
  assert.equal(built.parity, tweakPoint(INTERNAL, built.tweak).parity,
    "the parity is not the curve's answer");
  assert.equal(built.parity === 0 || built.parity === 1, true);

  const leafOf = {
    recovery: tapLeafHash(recoveryLeaf(NODE, genesis.bondMaturity)),
    slash: tapLeafHash(slashLeaf(ARBITRATION, genesis.arbitrationK)),
  };

  for (const path of ['recovery', 'slash']) {
    const block = controlBlockFor(path, built);
    assert.equal(block.ok, true, block.why);
    assert.equal(block.controlBlock.length, 65);
    assert.equal(block.controlBlock[0] & 1, built.parity, 'the parity is not in the first byte');
    assert.equal(block.controlBlock[0] & 0xfe, TAPLEAF_VERSION);
    assert.deepEqual(block.controlBlock.subarray(33),
      path === 'recovery' ? built.slash : built.recovery,
      'the sibling is not the other leaf');

    // REBUILD Q FROM WHAT A SPENDER SHOWS, and it is the key on chain.
    const back = rootFromControlBlock(leafOf[path], block.controlBlock);
    assert.equal(back.ok, true, back.why);
    const again = tweakPoint(back.internalKey, back.tweak);
    assert.deepEqual(again.outputKey, built.outputKey,
      `the ${path} path does not rebuild the output it is spending`);
    assert.equal(again.parity, built.parity);
  }

  // A CONTROL BLOCK NAMING THE WRONG SIBLING REBUILDS SOMETHING ELSE, so the
  // spend it belongs to would be for another output.
  const lying = controlBlockFor('recovery', { ...built, slash: b32(0x99) });
  const wrong = rootFromControlBlock(leafOf.recovery, lying.controlBlock);
  assert.notDeepEqual(tweakPoint(wrong.internalKey, wrong.tweak).outputKey, built.outputKey);

  // and so does the right sibling under the wrong leaf
  const swapped = rootFromControlBlock(leafOf.slash, controlBlockFor('recovery', built).controlBlock);
  assert.notDeepEqual(tweakPoint(swapped.internalKey, swapped.tweak).outputKey, built.outputKey);
});

/**
 * THE KEY PATH BELONGS TO THE NAMED KEYS, AND TO NOBODY ELSE.
 *
 * 5A.3B makes the internal key MuSig2(node_key, arbitration_aggregate_key).
 * A template that accepted thirty-two bytes for it would let a node post a
 * bond whose cooperative spend is a key only that node holds - and every check
 * would still pass, because the key would be an input to the check rather than
 * a fact derived from the keys the bond names.
 */
test('the internal key is the MuSig2 aggregate of the node and arbitration keys', () => {
  const derived = bondInternalKey({ nodeKey: NODE, arbitrationKeys: ARBITRATION }, { combine });
  assert.equal(derived.ok, true, derived.why);
  assert.equal(derived.internalKey.length, 32);
  assert.deepEqual(derived.internalKey, INTERNAL);

  // IT IS TWO STEPS, as the spec names two things: the arbitration set
  // aggregates to one key, and the internal key is the node with that.
  const set = aggregateKeys(ARBITRATION, { combine });
  assert.deepEqual(derived.arbitrationAggregate, set.key);
  assert.deepEqual(derived.internalKey, aggregateKeys([NODE, set.key], { combine }).key);

  // REPRODUCIBLE, and it is not the plain sum of the keys: every key gets a
  // coefficient, which is what stops a participant choosing their key so the
  // aggregate comes out as one they alone control.
  assert.deepEqual(bondInternalKey({ nodeKey: NODE, arbitrationKeys: ARBITRATION },
    { combine }).internalKey, derived.internalKey);
  assert.notDeepEqual(derived.internalKey, NODE);
  assert.notDeepEqual(derived.internalKey, set.key);

  // A DIFFERENT NODE IS A DIFFERENT KEY PATH.
  const other = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  assert.notDeepEqual(
    bondInternalKey({ nodeKey: other, arbitrationKeys: ARBITRATION }, { combine }).internalKey,
    derived.internalKey);

  // AND SO IS A DIFFERENT ARBITRATION SET.
  assert.notDeepEqual(
    bondInternalKey({ nodeKey: NODE, arbitrationKeys: [...ARBITRATION.slice(1), other] },
      { combine }).internalKey, derived.internalKey);

  // BIP-327 gives the SECOND distinct key a coefficient of one; without that
  // this aggregate would agree with no other MuSig2 implementation, and a key
  // path nobody else can sign is a key path that does not exist.
  const terms = keyAggCoefficients([NODE, set.key]);
  assert.equal(terms[1].coefficient[31], 1);
  assert.equal(terms[1].coefficient.slice(0, 31).every((b) => b === 0), true);
  assert.notEqual(terms[0].coefficient[31], 1);
});

/**
 * AND THE TEMPLATE HOLDS A CALLER TO IT.
 */
test('a bond whose internal key is not that aggregate is refused', () => {
  const good = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(good.ok, true, good.why);
  assert.deepEqual(good.internalKey, INTERNAL);

  // A key path only the node controls, offered as the internal key.
  const mine = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const stuffed = bondOutputKey({ ...inputs, internalKey: mine }, { tweakPoint, combine });
  assert.equal(stuffed.ok, false, 'a bond kept a key path of the caller\'s choosing');
  assert.match(stuffed.why, /not the MuSig2 aggregate of the node and arbitration keys/);

  // the recompute refuses it too, so a verifier cannot be handed one either
  assert.equal(bondOutputKeyMatches(good.outputKey, { ...inputs, internalKey: mine },
    { tweakPoint, combine }).ok, false);

  // AND THE WHOLE THING STILL RECOMPUTES END TO END with the derived key.
  assert.equal(bondOutputKeyMatches(good.outputKey, inputs, { tweakPoint, combine }).ok, true);
  const block = controlBlockFor('recovery', good);
  const back = rootFromControlBlock(tapLeafHash(recoveryLeaf(NODE, genesis.bondMaturity)),
    block.controlBlock);
  assert.deepEqual(tweakPoint(back.internalKey, back.tweak).outputKey, good.outputKey);

  // ONE CURVE IS NOT ENOUGH, and this is the bypass beside the door: a caller
  // passing only the tweak could otherwise still choose the internal key. The
  // two are the same curve - anything that can add t*G can add a_i*P_i - so
  // asking for both costs nothing and closes it.
  const oneCurve = bondOutputKey(inputs, { tweakPoint });
  assert.equal(oneCurve.ok, false, 'a tweak curve alone still built a bond');
  assert.match(oneCurve.why, /no curve was given to aggregate the key path/);
});
