// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A BOND SPEND SIGNS.
//
// These bytes were not derived from a published vector - this tree has none
// offline. They were MEASURED: a transaction built with exactly this sighash,
// this leaf and this control block was handed to a regtest bitcoind, which
// accepted it. `tools/bond-regtest.mjs` is that run, and it is the oracle.
//
// So a green test here says "these are the bytes bitcoind accepted", not "these
// match BIP-341's own vectors". That is a weaker claim about the code and a
// stronger one about the result, and it must not be read as the other thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapSighash, scriptPathWitness, serializeSpend, compactSize } from '../src/bond-spend.js';
import { recoveryLeaf, tapLeafHash } from '../src/bond-script.js';
import { genesisFor } from '../src/genesis.js';
import { toHex, fromHex } from '../src/hash.js';

const genesis = genesisFor('regtest');

// The vector: fixed keys, a fixed outpoint, fixed amounts. Only a signature is
// random, and the sighash is what a signature covers.
const NODE_KEY = fromHex('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa');
const OUTPUT_KEY = fromHex('fb0a797f025871162be6a1324da67c64234c10aacb309af30b7e7ab5450da51e');
const SPEND = {
  version: 2, locktime: genesis.bondMaturity,
  inputs: [{ txid: fromHex('22'.repeat(32)), vout: 1, sequence: 0xfffffffe }],
  outputs: [{ value: 99998000n, script: fromHex('0014' + '33'.repeat(20)) }],
};
const PREVOUTS = [{ value: 100000000n, script: fromHex('5120' + toHex(OUTPUT_KEY)) }];

test('the recovery leaf hashes to the leaf bitcoind was given', () => {
  const leaf = tapLeafHash(recoveryLeaf(NODE_KEY, genesis.bondMaturity));
  assert.equal(toHex(leaf),
    '29b15fdfb9cdfd0e23b8ccba647dee6c2e6ab711a2e6b2e24f404626b0df7e64');
});

test('the taproot sighash is the one the accepted spend signed', () => {
  const sighash = tapSighash({
    ...SPEND, prevouts: PREVOUTS, inputIndex: 0,
    leafHash: tapLeafHash(recoveryLeaf(NODE_KEY, genesis.bondMaturity)),
  });
  assert.equal(toHex(sighash),
    'a5510d85b9795b6af07a3f875fc2f267cb0d2df72350ef60b8e0f1ac50fcd97e');

  // EVERY PART OF THE SPEND IS IN IT. Taproot's change was to commit to the
  // amounts and scripts of what is being spent, not only the outpoints - so a
  // signer cannot be lied to about what it is signing away.
  const moved = (over, prevouts = PREVOUTS) => toHex(tapSighash({
    ...SPEND, ...over, prevouts, inputIndex: 0,
    leafHash: tapLeafHash(recoveryLeaf(NODE_KEY, genesis.bondMaturity)),
  }));
  const base = toHex(tapSighash({
    ...SPEND, prevouts: PREVOUTS, inputIndex: 0,
    leafHash: tapLeafHash(recoveryLeaf(NODE_KEY, genesis.bondMaturity)),
  }));
  assert.notEqual(moved({ locktime: genesis.bondMaturity + 1 }), base, 'the locktime is not signed');
  assert.notEqual(moved({ version: 1 }), base, 'the version is not signed');
  assert.notEqual(moved({ outputs: [{ ...SPEND.outputs[0], value: 99997000n }] }), base,
    'the output amount is not signed');
  assert.notEqual(moved({ inputs: [{ ...SPEND.inputs[0], sequence: 0xffffffff }] }), base,
    'the sequence is not signed');
  assert.notEqual(moved({}, [{ ...PREVOUTS[0], value: 90000000n }]), base,
    'the amount being spent is not signed - which is the whole of taproot\'s change');
  assert.notEqual(moved({}, [{ ...PREVOUTS[0], script: fromHex('5120' + '00'.repeat(32)) }]), base,
    'the script being spent is not signed');

  // and a different leaf is a different message, which is what stops a
  // signature for one path being replayed on the other
  assert.notEqual(toHex(tapSighash({
    ...SPEND, prevouts: PREVOUTS, inputIndex: 0, leafHash: new Uint8Array(32),
  })), base);
});

test('a witness is the stack, then the leaf, then the proof', () => {
  const script = recoveryLeaf(NODE_KEY, genesis.bondMaturity);
  const control = new Uint8Array(65).fill(9);
  const sig = new Uint8Array(64).fill(1);
  const witness = scriptPathWitness({ stack: [sig], script, controlBlock: control });

  assert.equal(witness.length, 3);
  assert.deepEqual(witness[0], sig);
  assert.deepEqual(witness[1], script);
  assert.deepEqual(witness[2], control);

  // A FIVE-OF-SEVEN STACK IS WRITTEN BOTTOM FIRST, which is the reverse of the
  // order the script pops - the first key it checks must end up on top, so its
  // signature is last in the list.
  const many = [1, 2, 3, 4, 5, 6, 7].map((n) => new Uint8Array(64).fill(n));
  const stacked = scriptPathWitness({ stack: many, script, controlBlock: control });
  assert.deepEqual(stacked[6], many[6]);
  assert.deepEqual(stacked[7], script);
});

test('the serialized spend carries its witness and its locktime', () => {
  const script = recoveryLeaf(NODE_KEY, genesis.bondMaturity);
  const witness = scriptPathWitness({
    stack: [new Uint8Array(64).fill(1)], script, controlBlock: new Uint8Array(65).fill(9),
  });
  const bytes = serializeSpend({ ...SPEND, witnesses: [witness] });

  assert.equal(bytes[0], 2, 'the version');
  assert.equal(bytes[4], 0x00, 'the segwit marker');
  assert.equal(bytes[5], 0x01, 'the segwit flag');
  // the locktime is the last four bytes, little endian
  assert.equal(bytes[bytes.length - 4], genesis.bondMaturity);
  assert.deepEqual(bytes.subarray(bytes.length - 3), new Uint8Array(3));

  // compact size is Bitcoin's, not a length byte of our own
  assert.deepEqual(compactSize(0xfc), Uint8Array.from([0xfc]));
  assert.deepEqual(compactSize(0xfd), Uint8Array.from([0xfd, 0xfd, 0x00]));
  assert.deepEqual(compactSize(0x10000), Uint8Array.from([0xfe, 0, 0, 1, 0]));
});

/**
 * A SLASH COMMITS TO THE PROOF THAT JUSTIFIED IT.
 *
 * 5A.3B step 4: "OP_RETURN = H(fraud_proof) || retrieval hint", and slash.js
 * fixes the hash as the proof's own id. "Because the slashing transaction
 * commits to the proof, every slash is permanently auditable."
 *
 * CONSENSUS DOES NOT ENFORCE THIS, and that is the point of checking it here.
 * Measured on a regtest node: a five-of-seven spend carrying no OP_RETURN is a
 * perfectly valid Bitcoin transaction and bitcoind ACCEPTED it. A bond taken
 * with no public record of why is the arbitration set's own offence, and the
 * only thing that can refuse it is the protocol.
 */
test('a slash carries the proof it commits to, and one that does not is refused', async () => {
  const { commitmentOutput, commitmentIn, spendCommitsTo } = await import('../src/bond-spend.js');
  const proof = fromHex('ab'.repeat(32));

  const out = commitmentOutput(proof);
  assert.equal(out.value, 0n, 'an OP_RETURN is unspendable, so it holds nothing');
  assert.equal(out.script[0], 0x6a, 'OP_RETURN');
  assert.equal(out.script[1], 32, 'a direct push of the proof id');
  assert.deepEqual(out.script.subarray(2), proof);

  // read back out of a transaction's outputs
  const outputs = [{ value: 1n, script: fromHex('0014' + '33'.repeat(20)) }, out];
  assert.deepEqual(commitmentIn(outputs).commitment, proof);
  assert.equal(spendCommitsTo(outputs, proof).ok, true);

  // NO COMMITMENT AT ALL, and A COMMITMENT TO SOMETHING ELSE, are different
  // failures - only one of them looks like a mistake.
  const bare = [{ value: 1n, script: fromHex('0014' + '33'.repeat(20)) }];
  assert.equal(spendCommitsTo(bare, proof).ok, false);
  assert.match(spendCommitsTo(bare, proof).why, /carries no proof commitment/);
  assert.match(spendCommitsTo([commitmentOutput(fromHex('cd'.repeat(32)))], proof).why,
    /commits to a different proof/);
  assert.equal(commitmentIn(bare), null);

  // THE RETRIEVAL HINT RIDES AFTER THE HASH and its shape is not invented here:
  // the spec fixes the hash and leaves the hint open, so whatever bytes a
  // caller appends come back unchanged.
  const hint = new TextEncoder().encode('ipfs://somewhere');
  const withHint = commitmentOutput(proof, hint);
  assert.deepEqual(commitmentIn([withHint]).commitment, proof);
  assert.deepEqual(commitmentIn([withHint]).hint, hint);

  // AN OP_RETURN THAT IS NOT A COMMITMENT IS NOT ONE. Transactions carry
  // OP_RETURNs for all sorts of reasons; a short one is somebody else's data,
  // and reading its first bytes as a proof id would let any transaction on
  // chain look like a slash of something.
  // Long enough to pass a length check and still not a commitment: two
  // twenty-byte pushes. Reading from byte two would take thirty-two bytes
  // spanning both, which is not an id anybody wrote.
  const twoPushes = {
    value: 0n,
    script: Uint8Array.from([0x6a, 20, ...new Uint8Array(20).fill(1), 20, ...new Uint8Array(20).fill(2)]),
  };
  assert.equal(twoPushes.script.length > 34, true, 'this fixture must survive the length check');
  assert.equal(commitmentIn([twoPushes]), null, "somebody else's data read as a proof id");
  assert.equal(spendCommitsTo([twoPushes], proof).ok, false);

  const shortData = {
    value: 0n, script: Uint8Array.from([0x6a, 8, 1, 2, 3, 4, 5, 6, 7, 8]),
  };
  assert.equal(commitmentIn([shortData]), null, 'eight bytes of data read as a proof id');
  assert.equal(spendCommitsTo([shortData], proof).ok, false);

  // and the limits are Bitcoin's, not ours
  assert.throws(() => commitmentOutput(new Uint8Array(31)), /32-byte proof id/);
  assert.throws(() => commitmentOutput(proof, new Uint8Array(49)), /at most 80 bytes/);
});
