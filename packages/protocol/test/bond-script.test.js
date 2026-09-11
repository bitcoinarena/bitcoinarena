// THE BOND OUTPUT KEY IS THE TAPROOT TWEAK OF THE KEYS AND THE MATURITY.
//
// A taproot output shows nothing until it is spent, which is why 5A.3B chose
// it and why "check the script" cannot mean read it. It means recompute: build
// the tree from what a node declares and see whether the 32 bytes on chain are
// the answer. This package does the hashing; the one point addition belongs to
// a caller's curve, and the tests here use a stub for it - the real secp256k1
// does the same arithmetic one package over, where the dependency lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoveryLeaf, slashLeaf, tapLeafHash, tapBranchHash, tapTweak,
  bondTapTree, bondOutputKey, bondOutputKeyMatches, TAPLEAF_VERSION,
  controlBlockFor, rootFromControlBlock,
} from '../src/bond-script.js';
import { genesisFor } from '../src/genesis.js';
import { bondInternalKey } from '../src/bond-script.js';
import { toHex, taggedHash } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ARBITRATION = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xa0 + n));
const genesis = genesisFor('regtest');

/**
 * A stub aggregate: the sum is H(each key and its coefficient), which is not a
 * group but is a function - enough to show the internal key is DERIVED from
 * the named keys rather than chosen, which is what this package is responsible
 * for. The real point arithmetic is one package over.
 */
const combine = (terms) => taggedHash('TestAggregate',
  Uint8Array.from(terms.flatMap((t) => [...t.key, ...t.coefficient])));

const INTERNAL = bondInternalKey({ nodeKey: NODE, arbitrationKeys: ARBITRATION },
  { combine }).internalKey;

const inputs = {
  nodeKey: NODE, arbitrationKeys: ARBITRATION, arbitrationK: genesis.arbitrationK,
  bondMaturity: genesis.bondMaturity, internalKey: INTERNAL,
};

/**
 * A stub curve: Q = H(P || t), which is not a group but is a function - and it
 * answers with the parity too, because a curve that only returned 32 bytes
 * could not say whether Q is even or odd, and the control block needs that bit.
 */
const tweakPoint = (internalKey, tweak) => {
  const outputKey = taggedHash('TestTweak', Uint8Array.from([...internalKey, ...tweak]));
  return { outputKey, parity: outputKey[31] & 1 };
};

/**
 * K AND M COME OFF GENESIS, so every node on a network builds one tree.
 */
test('five of seven comes off genesis, beside the maturity', () => {
  assert.equal(genesis.arbitrationK, 5);
  assert.equal(genesis.arbitrationM, 7);
  assert.equal(genesis.bondMaturity, 100);
  assert.equal(genesisFor('testnet4').arbitrationK, 5);
});

/**
 * THE TWO LEAVES, AS 5A.3B WRITES THEM.
 */
test('the recovery leaf locks the time first and ends on a signature', () => {
  const leaf = recoveryLeaf(NODE, 100);

  // <maturity> CLTV DROP <node_key> CHECKSIG. The other order - the one 5A.3B
  // writes - ends on DROP with an empty stack, and a script that ends empty
  // does not spend. This is the path that returns the node's money if
  // arbitration disappears, so it has to be the one that runs.
  assert.equal(leaf[0], 0x01, 'a locktime of 100 is one byte');
  assert.equal(leaf[1], 100);
  assert.equal(leaf[2], 0xb1, 'CHECKLOCKTIMEVERIFY');
  assert.equal(leaf[3], 0x75, 'DROP');
  assert.equal(leaf[4], 0x20, 'the key is not pushed as 32 bytes');
  assert.deepEqual(leaf.subarray(5, 37), NODE);
  assert.equal(leaf[37], 0xac, 'CHECKSIG');
  assert.equal(leaf.length, 38);
  assert.equal(leaf[leaf.length - 1] === 0x75, false, 'the leaf still ends on DROP');

  // THE MATURITY IS IN THE BYTES, so a different one is a different leaf and
  // therefore a different output key. That is the point of path A.
  assert.notDeepEqual(recoveryLeaf(NODE, 101), leaf);
  assert.notDeepEqual(recoveryLeaf(b32(0x12), 100), leaf);

  // a locktime whose top byte would read as negative is padded
  assert.equal(recoveryLeaf(NODE, 200)[0], 0x02);
  assert.equal(recoveryLeaf(NODE, 200)[2], 0x00, 'a high byte was not padded');
});

test('the slash leaf counts signatures the way tapscript does', () => {
  const leaf = slashLeaf(ARBITRATION, 5);

  // <k1> CHECKSIG <k2> CHECKSIGADD ... <k7> CHECKSIGADD <5> NUMEQUAL.
  // CHECKMULTISIG is not in tapscript at all (BIP-342), so a leaf using it is
  // invalid the moment it is revealed - and its hash would already be in the
  // output key by then.
  assert.equal(leaf[0], 0x20);
  assert.equal(leaf[33], 0xac, 'the first key is a plain CHECKSIG');
  assert.equal(leaf[34], 0x20);
  assert.equal(leaf[67], 0xba, 'the second key adds to the count');
  assert.equal(leaf[leaf.length - 2], 0x55, 'OP_5, the quorum to compare against');
  assert.equal(leaf[leaf.length - 1], 0x9c, 'NUMEQUAL');
  assert.equal(leaf.includes(0xae), false, 'CHECKMULTISIG is still in the leaf');
  assert.equal(leaf.length, 7 * 33 + 7 + 1 + 1);

  // SORTED, so one arrangement is one leaf however the keys were listed
  assert.deepEqual(slashLeaf([...ARBITRATION].reverse(), 5), leaf);

  // and a different set, or a different k, is a different leaf
  assert.notDeepEqual(slashLeaf(ARBITRATION, 4), leaf);
  assert.notDeepEqual(slashLeaf([...ARBITRATION.slice(1), b32(0xff)], 5), leaf);

  assert.throws(() => slashLeaf(ARBITRATION, 8), /8 of 7 cannot be satisfied/);
  assert.throws(() => slashLeaf([], 1), /needs the arbitration keys/);
});

/**
 * BIP-341's OWN HASHES, not an invention: leaf, branch, tweak.
 */
test('the tree is BIP-341: tagged leaf, sorted branch, tweak over the root', () => {
  const a = tapLeafHash(recoveryLeaf(NODE, 100));
  const b = tapLeafHash(slashLeaf(ARBITRATION, 5));

  // the leaf hash is over version || length || script
  const script = recoveryLeaf(NODE, 100);
  assert.deepEqual(a, taggedHash('TapLeaf',
    Uint8Array.from([TAPLEAF_VERSION, script.length, ...script])));

  // THE BRANCH IS SORTED, so the two children have one parent whichever way
  // they arrive - two nodes ordering them differently would compute two
  // output keys for one bond.
  assert.deepEqual(tapBranchHash(a, b), tapBranchHash(b, a));

  const tree = bondTapTree(inputs, { combine });
  assert.deepEqual(tree.recovery, a);
  assert.deepEqual(tree.slash, b);
  assert.deepEqual(tree.merkleRoot, tapBranchHash(a, b));
  assert.deepEqual(tree.tweak, tapTweak(INTERNAL, tree.merkleRoot));

  // AND A DIFFERENT INTERNAL KEY IS NOT A DIFFERENT BOND, IT IS NO BOND: the
  // tree refuses one that is not the aggregate of the named keys, so there is
  // nothing to compare tweaks against.
  assert.throws(() => bondTapTree({ ...inputs, internalKey: b32(0x23) }, { combine }),
    /not the MuSig2 aggregate/);

  // and no tree at all without a curve to check the key path with
  assert.throws(() => bondTapTree(inputs), /no curve was given to aggregate/);
});

/**
 * AND THE RECOMPUTE, WHICH IS THE WHOLE POINT: the same function that builds
 * the key answers whether 32 bytes on chain are it.
 */
test('an output key recomputes from its inputs, and refuses when one moves', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.outputKey.length, 32);

  const good = bondOutputKeyMatches(built.outputKey, inputs, { tweakPoint, combine });
  assert.equal(good.ok, true, good.why);

  // EVERY DECLARED INPUT MOVES THE KEY. If one did not, it could be changed
  // after the fact without the output changing - which is the whole thing a
  // commitment is for.
  const moved = [
    ['the node key', { nodeKey: b32(0x12) }],
    ['the maturity', { bondMaturity: 101 }],
    ['the quorum', { arbitrationK: 4 }],
    ['an arbitration key', { arbitrationKeys: [...ARBITRATION.slice(1), b32(0xff)] }],
  ];
  for (const [what, over] of moved) {
    // The internal key is re-derived for each, because it is a FUNCTION of the
    // node and arbitration keys - a case that kept the old one would be
    // refused by the aggregate check and never reach the tweak.
    const withKeys = { ...inputs, ...over };
    const derived = bondInternalKey(withKeys, { combine });
    const seen = bondOutputKeyMatches(built.outputKey,
      { ...withKeys, internalKey: derived.ok ? derived.internalKey : withKeys.internalKey },
      { tweakPoint, combine });
    assert.equal(seen.ok, false, `${what} did not move the output key`);
    assert.match(seen.why, /not the taproot tweak of the keys and maturity it declares/);
  }

  // AND AN INTERNAL KEY THE CALLER CHOSE IS REFUSED BEFORE THE TWEAK IS EVEN
  // TAKEN - a stronger refusal, and a different mistake.
  const stuffed = bondOutputKeyMatches(built.outputKey, { ...inputs, internalKey: b32(0x23) },
    { tweakPoint, combine });
  assert.equal(stuffed.ok, false);
  assert.match(stuffed.why, /not the MuSig2 aggregate of the node and arbitration keys/);

  // NO CURVE IS NOT A PASS. A caller with nothing to add the tweak with is
  // told so, rather than handed a key it did not compute.
  assert.equal(bondOutputKey(inputs).ok, false);
  assert.match(bondOutputKey(inputs).why, /no curve was given to add the tweak/);
  assert.equal(bondOutputKeyMatches(built.outputKey, inputs).ok, false);

  // AND ONE CURVE IS NOT ENOUGH. A caller passing only the tweak could still
  // choose the internal key, which is the bypass beside the door.
  assert.match(bondOutputKey(inputs, { tweakPoint }).why,
    /no curve was given to aggregate the key path/);

  // and 32 bytes is what an output key is
  assert.match(bondOutputKeyMatches(new Uint8Array(31), inputs, { tweakPoint, combine }).why,
    /not a 32-byte taproot output key/);
  assert.match(bondOutputKey({ ...inputs, internalKey: b32(1).subarray(0, 16) },
    { tweakPoint, combine }).why, /internal key is 32 bytes/);
});

/**
 * THE STUB IS GONE. Every fixture bond used to carry 0x77 repeated - a key
 * derived from nothing, which no verifier could recompute, so a bond output
 * was unfalsifiable by construction.
 */
test('the bond builder no longer writes a key derived from nothing', async () => {
  const { bondTransaction } = await import('../tools/bond.js');
  const { parseTransaction } = await import('../src/tx.js');
  const advert = {
    nodePubkey: NODE, operatorId: 'operator', protocolVersions: [1], roles: ['game'],
    endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
    settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
    bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [],
    timestamp: 1788700000000n,
  };
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  const tx = parseTransaction(bondTransaction(advert, { outputKey: built.outputKey }));

  const script = tx.outputs[0].script;
  assert.equal(script[0], 0x51);
  assert.equal(script[1], 0x20);
  assert.deepEqual(script.subarray(2, 34), built.outputKey);
  assert.equal(script.subarray(2, 34).every((b) => b === 0x77), false,
    'the bond output is still the filler key');
});

/**
 * THE CONTROL BLOCK, WITHOUT WHICH NEITHER LEAF IS REACHABLE.
 *
 * The output key hides the tree - that is what taproot is for - so a spender
 * has to hand the tree over at spend time. A bond whose control block nobody
 * could build is a bond nobody could recover, and path A exists precisely so
 * that arbitration cannot freeze one forever.
 */
test('each leaf gets a control block that proves it belongs to the output', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.parity === 0 || built.parity === 1, true, 'the parity was not kept');

  for (const path of ['recovery', 'slash']) {
    const block = controlBlockFor(path, built);
    assert.equal(block.ok, true, block.why);

    // BIP-341: (leaf_version | parity) || internal_key || one sibling
    assert.equal(block.controlBlock.length, 65, 'a two-leaf tree proves in 65 bytes');
    assert.equal(block.controlBlock[0] & 0xfe, TAPLEAF_VERSION);
    assert.equal(block.controlBlock[0] & 1, built.parity, 'the parity is not in the first byte');
    assert.deepEqual(block.controlBlock.subarray(1, 33), INTERNAL);

    // THE SIBLING IS THE OTHER LEAF. Naming its own leaf would rebuild a
    // different root and prove nothing.
    const sibling = path === 'recovery' ? built.slash : built.recovery;
    assert.deepEqual(block.controlBlock.subarray(33), sibling);

    // AND IT REBUILDS THE ROOT THIS OUTPUT COMMITTED TO.
    const leaf = path === 'recovery'
      ? tapLeafHash(recoveryLeaf(NODE, 100)) : tapLeafHash(slashLeaf(ARBITRATION, 5));
    const back = rootFromControlBlock(leaf, block.controlBlock);
    assert.equal(back.ok, true, back.why);
    assert.deepEqual(back.merkleRoot, built.merkleRoot);
    assert.deepEqual(back.tweak, built.tweak);
    assert.equal(back.parity, built.parity);
  }

  // A CONTROL BLOCK NAMING THE WRONG SIBLING PROVES A DIFFERENT TREE.
  const wrong = controlBlockFor('recovery', { ...built, slash: b32(0x99) });
  const leaf = tapLeafHash(recoveryLeaf(NODE, 100));
  assert.notDeepEqual(rootFromControlBlock(leaf, wrong.controlBlock).merkleRoot, built.merkleRoot);

  // and the refusals
  assert.match(controlBlockFor('key', built).why, /recovery path and a slash path/);
  assert.match(controlBlockFor('recovery', { ...built, parity: undefined }).why,
    /carries the output key parity/);
  assert.match(rootFromControlBlock(leaf, new Uint8Array(40)).why, /33 bytes plus one hash/);
  assert.match(rootFromControlBlock(leaf, new Uint8Array(65)).why, /another leaf version/);
});

/**
 * A CURVE THAT WILL NOT SAY WHETHER Q IS EVEN OR ODD CANNOT BUILD A BOND.
 *
 * An assumed parity is a bond that cannot be recovered half the time, and the
 * recovery path exists so that a bond can ALWAYS be recovered.
 */
test('a curve that answers without the parity is refused', () => {
  const halfAnswer = (internalKey, tweak) => taggedHash('TestTweak',
    Uint8Array.from([...internalKey, ...tweak]));
  const seen = bondOutputKey(inputs, { tweakPoint: halfAnswer, combine });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /did not return a 32-byte key|even or odd/);

  const twoish = () => ({ outputKey: b32(1), parity: 2 });
  assert.match(bondOutputKey(inputs, { tweakPoint: twoish, combine }).why, /even or odd/);
});

/**
 * THE LEAF FIX IS PINNED. These two numbers are what the programs of this
 * template produce; if either moves, the leaves moved, and every bond already
 * posted would be spending a different tree.
 */
test('the tree and the output key are the ones the spendable leaves produce', () => {
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  assert.equal(toHex(built.merkleRoot),
    '4e8367ddbb37d1d8f78db1fceaef3bb2067c37b94e5786810270a19b68aaf938',
    'the merkle root moved, so the leaf programs are not the ones measured');
  // The output key under the stub curve moved once - not because the leaves
  // moved, which the root above still holds, but because this fixture stopped
  // stuffing an internal key and started DERIVING it from the named keys.
  // 704bf508... was the value while the internal key was a made-up b32(0x22).
  assert.equal(toHex(built.outputKey),
    '9e0435f63d2fada85daf74878d805d4a30fcfe35794b6b662d534024921656ff',
    'the output key moved under the stub curve');
  assert.notEqual(toHex(built.outputKey),
    '704bf508a57b0ec51898ee67a523184ff344025a6f80ff98dbfe4db210d2b4fd');

  // and the empty-stack order is what it used to be, which is why it moved
  assert.notEqual(toHex(built.merkleRoot),
    'bcd9435549f84e683dbc3cfaaf0949b0ba2dea542e08b1edf5d005cd93106a1f');
});
