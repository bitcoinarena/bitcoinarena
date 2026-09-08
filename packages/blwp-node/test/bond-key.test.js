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
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { taggedHash, toHex } from '../../protocol/src/hash.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { recognizeBond, bondKeyMatches, acceptAdvert } from '../../protocol/src/chain.js';
import { resolveCensus, deriveCensus } from '../../protocol/src/census.js';
import { blockOf } from '../../protocol/tools/bond.js';
import { chainOf } from '../../protocol/tools/chainview.js';
import { hash256 } from '../../protocol/src/chain.js';
import { BOND_SCRIPT_TEMPLATE_VERSION } from '../../protocol/src/bond-script.js';

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
  assert.deepEqual(built.tweak, bondTapTree(inputs, { combine }).tweak);
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

/**
 * A SECOND NODE REBUILDS THE BOND FROM THE PUBLISHED BODY AND GENESIS ALONE.
 *
 * This is the whole point of the letter. The first node picks a key and posts;
 * the second holds no fixture, no shared object, nothing the first told it
 * except the advertisement that travels in the funding transaction - and it
 * must arrive at the same output key and the same two control blocks, or the
 * census is trusting the poster.
 */
test('a second node rebuilds the same output key and both control blocks from genesis', () => {
  const poster = schnorr.utils.randomSecretKey();
  const nodeKey = schnorr.getPublicKey(poster);

  // WHAT THE FIRST NODE BUILDS, from the network's own set and maturity.
  const set = genesis.arbitrationKeys;
  const mine = {
    nodeKey, arbitrationKeys: set, arbitrationK: genesis.arbitrationK,
    bondMaturity: genesis.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: set }, { combine }).internalKey,
  };
  const built = bondOutputKey(mine, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);

  // WHAT THE SECOND NODE HAS: the body, and its own copy of genesis.
  const body = {
    nodePubkey: nodeKey, operatorId: 'somebody', protocolVersions: [1], roles: ['game'],
    endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
    settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
    bondVout: 0, bondScriptTemplateVersion: BOND_SCRIPT_TEMPLATE_VERSION,
    payoutPubkey: b32(3), timestamp: 1788700000000n,
  };
  const theirs = genesisFor('regtest');
  const rebuilt = bondOutputKey({
    nodeKey: body.nodePubkey,
    arbitrationKeys: theirs.arbitrationKeys,
    arbitrationK: theirs.arbitrationK,
    bondMaturity: theirs.bondMaturity,
    internalKey: bondInternalKey(
      { nodeKey: body.nodePubkey, arbitrationKeys: theirs.arbitrationKeys }, { combine }).internalKey,
  }, { tweakPoint, combine });

  assert.equal(rebuilt.ok, true, rebuilt.why);
  assert.deepEqual(rebuilt.outputKey, built.outputKey, 'the second node rebuilt a different bond');
  assert.equal(rebuilt.parity, built.parity);
  for (const path of ['recovery', 'slash']) {
    assert.deepEqual(controlBlockFor(path, rebuilt).controlBlock,
      controlBlockFor(path, built).controlBlock,
      `the two nodes disagree about the ${path} control block`);
  }

  // THE SET IS THE NETWORK'S, NOT THE POSTER'S. A bond built over any other
  // seven keys is a different output, and the second node's rebuild says so.
  const ownSet = [1, 2, 3, 4, 5, 6, 7].map(() => schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const captured = bondOutputKey({
    ...mine, arbitrationKeys: ownSet,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: ownSet }, { combine }).internalKey,
  }, { tweakPoint, combine });
  assert.notDeepEqual(captured.outputKey, built.outputKey,
    'a poster naming its own arbitration set produced the same bond');
});

/**
 * AND THE CHAIN DOOR STOPS SAYING IT CANNOT CHECK.
 */
test('recognizeBond recomputes the output key and drops it from unchecked', () => {
  const poster = schnorr.utils.randomSecretKey();
  const nodeKey = schnorr.getPublicKey(poster);
  const g = genesisFor('regtest');
  const bond = {
    arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity, tweakPoint, combine,
  };
  const key = bondOutputKey({
    nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
  }, { tweakPoint, combine });

  const advert = {
    nodePubkey: nodeKey, operatorId: 'operator', protocolVersions: [1], roles: ['game'],
    endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
    settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
    bondVout: 0, bondScriptTemplateVersion: BOND_SCRIPT_TEMPLATE_VERSION,
    payoutPubkey: b32(3), timestamp: 1788700000000n,
  };
  const tx = parseTransaction(bondTransaction(advert, { outputKey: key.outputKey }));

  const seen = recognizeBond(tx, 0, advert, { bond });
  assert.equal(seen.ok, true, seen.why);
  assert.deepEqual(seen.outputKey, key.outputKey);
  assert.equal(seen.unchecked.some((u) => /script template/.test(u)), false,
    'the door still says it cannot read the template after reading it');

  // WITHOUT THE KEYS IT SAYS SO, exactly as before - nothing pretends.
  const blind = recognizeBond(tx, 0, advert);
  assert.equal(blind.ok, true, blind.why);
  assert.equal(blind.unchecked.some((u) => /script template/.test(u)), true);

  // A BOND OVER SOMEBODY ELSE'S KEY IS REFUSED BY NAME.
  const other = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const stranger = parseTransaction(bondTransaction({ ...advert, nodePubkey: other },
    { outputKey: key.outputKey }));
  const wrong = recognizeBond(stranger, 0, { ...advert, nodePubkey: other }, { bond });
  assert.equal(wrong.ok, false, "a bond built for one key was accepted for another's");
  assert.match(wrong.why, /not the taproot tweak/);

  // A MATURITY THE POSTER CHOSE IS NOT THE NETWORK'S. Already matured is a
  // bond withdrawable the moment it is posted - at no risk, and counted.
  const early = bondOutputKey({
    nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: 1,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
  }, { tweakPoint, combine });
  const cheap = parseTransaction(bondTransaction(advert, { outputKey: early.outputKey }));
  assert.equal(recognizeBond(cheap, 0, advert, { bond }).ok, false,
    'a bond that had already matured was recognised');

  // AND A BODY NAMING ANOTHER TEMPLATE IS NOT REBUILT AT ALL.
  const v2 = { ...advert, bondScriptTemplateVersion: 2 };
  const seen2 = bondKeyMatches(tx.outputs[0].script, v2, bond);
  assert.equal(seen2.ok, false);
  assert.match(seen2.why, /names bond script template 2, and this is template 1/);
});

/**
 * THE CENSUS AND THE PLAYER'S DOOR BOTH ASK THE QUESTION NOW.
 *
 * A door nobody walks through is not a door. `recognizeBond` learned to rebuild
 * the key a node's own keys produce, and until this the census and
 * `acceptAdvert` called it without the set - so eligibility, and the endpoint a
 * player is handed, still rested on whatever thirty-two bytes the poster wrote.
 */
const g = genesisFor('regtest');
const BOND = {
  arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
  bondMaturity: g.bondMaturity, tweakPoint, combine,
};

const bodyFor = (nodeKey, over = {}) => ({
  nodePubkey: nodeKey, operatorId: 'operator', protocolVersions: [1], roles: ['game'],
  endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: BOND_SCRIPT_TEMPLATE_VERSION,
  payoutPubkey: b32(3), timestamp: 1788700000000n, ...over,
});

/** A bond for a node key, over the network's set unless told otherwise. */
const bondFor = (nodeKey, { maturity = g.bondMaturity, set = g.arbitrationKeys } = {}) =>
  bondOutputKey({
    nodeKey, arbitrationKeys: set, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: set }, { combine }).internalKey,
  }, { tweakPoint, combine }).outputKey;

test('the census counts the honest bond and excludes the stranger by name', () => {
  const honest = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const liar = schnorr.getPublicKey(schnorr.utils.randomSecretKey());

  // one real bond, and one whose output is a stranger's taproot key - which is
  // indistinguishable on chain, since a P2TR output is thirty-two bytes.
  const good = bondTransaction(bodyFor(honest), { outputKey: bondFor(honest) });
  const bad = bondTransaction(bodyFor(liar), {
    outputKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    previousTxid: b32(0xb1),
  });
  const entryOf = (tx, key) => ({
    txid: parseTransaction(tx).txid, vout: 0, pubkey: key,
    bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
  });
  const byKey = new Map([[toHex(honest), good], [toHex(liar), bad]]);
  const resolve = (e) => ({ transaction: byKey.get(toHex(e.pubkey)) });
  const contract = { bondMinSats: 50000n, protocolVersion: 1 };
  const entries = [entryOf(good, honest), entryOf(bad, liar)];

  const seen = resolveCensus(entries, { contract, resolve, bond: BOND });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.eligible.length, 1,
    `expected one eligible, got ${seen.eligible.length}; excluded: ${seen.excluded.map((e) => e.why).join(' | ')}`);
  assert.deepEqual(seen.eligible[0].pubkey, honest);
  assert.equal(seen.excluded.length, 1);
  assert.match(seen.excluded[0].why, /not the taproot tweak of the keys and maturity it declares/);

  // AND THE UNCHECKED LIST SHRINKS ONLY WHEN IT CAN.
  assert.equal(seen.unchecked.some((u) => /script template/.test(u)), false);
  const blind = resolveCensus(entries, { contract, resolve });
  assert.equal(blind.eligible.length, 2, 'without the set the census used to count both, and must still');
  assert.equal(blind.unchecked.some((u) => /script template/.test(u)), true);
});

test('a bond already mature at posting is excluded by the census, not only by the door', () => {
  const node = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const cheap = bondTransaction(bodyFor(node), { outputKey: bondFor(node, { maturity: 1 }) });
  const entry = {
    txid: parseTransaction(cheap).txid, vout: 0, pubkey: node,
    bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
  };
  const contract = { bondMinSats: 50000n, protocolVersion: 1 };

  const seen = resolveCensus([entry], { contract, resolve: () => ({ transaction: cheap }), bond: BOND });
  assert.equal(seen.eligible.length, 0,
    'a bond withdrawable the moment it was posted was counted as one at stake');
  assert.match(seen.excluded[0].why, /not the taproot tweak/);

  // and without the set it is counted, exactly as before
  assert.equal(resolveCensus([entry], { contract, resolve: () => ({ transaction: cheap }) })
    .eligible.length, 1);
});

test("the player's door refuses the same three bonds", () => {
  const node = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const at = (tx) => {
    const txid = parseTransaction(tx).txid;
    const sibling = new Uint8Array(32).fill(0x99);
    return { ...blockOf(hash256, [txid, sibling]), branch: [sibling], position: 0 };
  };

  const good = bondTransaction(bodyFor(node), { outputKey: bondFor(node) });
  const ok = acceptAdvert({ transaction: good, ...at(good), bond: BOND });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.unchecked.some((u) => /script template/.test(u)), false);

  // a stranger's taproot output, an already-mature bond, and a set of the
  // poster's own choosing - each refused at the door a player walks through
  const cases = [
    ['a stranger\'s output', schnorr.getPublicKey(schnorr.utils.randomSecretKey())],
    ['an already-mature bond', bondFor(node, { maturity: 1 })],
    ['the poster\'s own set', bondFor(node, {
      set: [1, 2, 3, 4, 5, 6, 7].map(() => schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    })],
  ];
  for (const [what, outputKey] of cases) {
    const tx = bondTransaction(bodyFor(node), { outputKey, previousTxid: b32(0xc1) });
    const seen = acceptAdvert({ transaction: tx, ...at(tx), bond: BOND });
    assert.equal(seen.ok, false, `${what} was accepted`);
    assert.match(seen.why, /not the taproot tweak/);

    // and without the set the door answers as it always did
    const blind = acceptAdvert({ transaction: tx, ...at(tx) });
    assert.equal(blind.ok, true, `${what}: the door changed without being given the set`);
    assert.equal(blind.unchecked.some((u) => /script template/.test(u)), true);
  }
});

/**
 * THE SCAN FINDS ITS OWN CANDIDATES, AND THE CURVE REFUSES THE STRANGER.
 *
 * 5A.4 step 1 is "scan for the round's BOND_MARKER", not "be handed a list",
 * and `scanCensus` now does that. The protocol package can measure that it
 * FINDS them; it cannot measure that a found output is the poster's own bond,
 * because that recompute is a point addition and that package carries no
 * curve - with no set injected the template check is honestly parked in
 * `unchecked`, so a stranger's key is found and COUNTED there.
 *
 * This is the caller that brings a curve, so this is the only place where
 * "found by the marker alone, then refused by name" can be seen end to end.
 */
test('a bond the scan found by itself is refused when its key does not recompute', () => {
  const honest = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const liar = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
  const quiet = schnorr.getPublicKey(schnorr.utils.randomSecretKey());

  const good = bondTransaction(bodyFor(honest), {
    outputKey: bondFor(honest), previousTxid: b32(0xd1),
  });
  // Marked, committed, taproot, a whole bitcoin, deep enough - and a stranger's
  // key. Every rule that does not need a curve passes it.
  const bad = bondTransaction(bodyFor(liar), {
    outputKey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    previousTxid: b32(0xd2),
  });
  // A real bond that never paid the marker. It is a fine transaction and it is
  // not this round's chain state, so the scan must not reach it at all.
  const unmarked = bondTransaction(bodyFor(quiet), {
    outputKey: bondFor(quiet), marker: false, previousTxid: b32(0xd3),
  });

  const CENSUS = 900000, TIP = CENSUS + 6, FROM = CENSUS - 20;
  const at = { [CENSUS - 20]: [good], [CENSUS - 10]: [bad, unmarked] };
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: at[h] || [] });

  const byKey = new Map([
    [toHex(honest), good], [toHex(liar), bad], [toHex(quiet), unmarked],
  ]);
  const contract = {
    bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST,
    censusHeight: CENSUS, censusConfirmations: 6,
  };
  // NO `candidates`. Nobody hands this census a single outpoint.
  const out = deriveCensus(chainOf(blocks, FROM), {
    contract, bond: BOND,
    resolve: (e) => ({ transaction: byKey.get(toHex(e.pubkey)) }),
  });
  assert.equal(out.ok, true, out.why);

  assert.equal(out.entries.length, 1,
    `expected the honest bond alone; excluded: ${out.excluded.map((e) => e.why).join(' | ')}`);
  assert.deepEqual(out.entries[0].pubkey, honest);

  // FOUND, then named - not quietly skipped in the scan.
  const refused = out.excluded.find((e) => toHex(e.pubkey) === toHex(liar));
  assert.ok(refused, 'the stranger was dropped silently instead of named');
  assert.match(refused.why, /not the taproot tweak of the keys and maturity it declares/);

  // and the unmarked bond was never a candidate, in either list
  const seen = [...out.entries, ...out.excluded].map((e) => toHex(e.pubkey));
  assert.equal(seen.includes(toHex(quiet)), false,
    'an output that never paid this round\'s marker was scanned anyway');
});
