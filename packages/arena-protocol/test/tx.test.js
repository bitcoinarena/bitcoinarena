// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BITCOIN TRANSACTION, READ WELL ENOUGH TO FIND AN ENDPOINT IN IT.
//
// Measured against real mainnet transactions, fetched once and written down
// here so the test needs no network: a coinbase and a spend from block 500000
// and the legacy transaction block 100000 is already proven by in chain.test.js.
// For each one the parser has to produce the txid Bitcoin itself calls it by.
// That is the only check worth making, because the txid is what a merkle proof
// is about - a parser that computed a different one would refuse every genuine
// advertisement and, worse, would be free to accept whatever it did compute.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTransaction, commitmentsOf, witnessItemsOf, readVarint, hash256,
} from '../src/tx.js';
import { fromHex, toHex } from '../src/hash.js';

/** A txid as an API prints it is REVERSED from the way it is hashed. */
const named = (tx) => toHex(tx.txid.slice().reverse());

// mainnet block 500000, coinbase. Segwit-serialised, and its second output is
// an OP_RETURN - the witness commitment - so it is also a real example of the
// shape a bond output's commitment takes.
const COINBASE_500000 = fromHex(
  '01000000000101000000000000000000000000000000000000000000000000000000'
  + '0000000000ffffffff4b0320a107046f0a385a632f4254432e434f4d2ffabe6d6dbd'
  + 'd0ee86f9a1badfd0aa1b3c9dac8d90840cf973f7b2590d6c9adde1a6e0974a010000'
  + '000000000001283da9a172020000000000ffffffff02c994bb5e0000000017a91422'
  + '8f554bbf766d6f9cc828de1126e3d35d15e5fe870000000000000000266a24aa21a9'
  + 'ed10109f4b82aa3ed7ec9d02a2a90246478b3308c8b85daf62fe501d58d05727a401'
  + '20000000000000000000000000000000000000000000000000000000000000000000'
  + '000000');

// mainnet block 500000, the transaction at index 1. A segwit spend.
const SPEND_500000 = fromHex(
  '01000000000101d553fbabaf1b26977b6e5d403af9f4b567b3e28484321a6fb02e28'
  + '24984e3e5000000000171600142b2296c588ec413cebd19c3cbc04ea830ead6e78ff'
  + 'ffffff01be1611020000000017a91487e4e5a7ff7bf78b8a8972a49381c8a673917f'
  + '3e870247304402205f39ccbab38b644acea0776d18cb63ce3e37428cbac06dc23b59'
  + 'c61607aef69102206b8610827e9cb853ea0ba38983662034bd3575cc1ab118fb66d6'
  + 'a98066fa0bed01210304c01563d46e38264283b99bb352b46e69bf132431f102d4bd'
  + '9a9d8dab075e7f00000000');

// mainnet block 100000, the transaction at index 1. Pre-segwit.
const LEGACY_100000 = fromHex(
  '0100000001032e38e9c0a84c6046d687d10556dcacc41d275ec55fc00779ac88fdf3'
  + '57a187000000008c493046022100c352d3dd993a981beba4a63ad15c209275ca9470'
  + 'abfcd57da93b58e4eb5dce82022100840792bc1f456062819f15d33ee7055cf7b5ee'
  + '1af1ebcc6028d9cdb1c3af7748014104f46db5e9d61a9dc27b8d64ad23e7383a4e6c'
  + 'a164593c2527c038c0857eb67ee8e825dca65046b82c9331586c82e0fd1f633f25f8'
  + '7c161bc6f8a630121df2b3d3ffffffff0200e32321000000001976a914c398efa9c3'
  + '92ba6013c5e04ee729755ef7f58b3288ac000fe208010000001976a914948c765a69'
  + '14d43f2a7ac177da2c2f6b52de3d7c88ac00000000');

test('a real segwit coinbase parses to the txid Bitcoin calls it by', () => {
  const tx = parseTransaction(COINBASE_500000);
  assert.equal(named(tx),
    '2157b554dcfda405233906e461ee593875ae4b1b97615872db6a25130ecc1dd6');
  assert.equal(tx.segwit, true);
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.version, 1);
  assert.equal(tx.locktime, 0);
});

test('a real segwit spend, and a real legacy transaction, both do too', () => {
  assert.equal(named(parseTransaction(SPEND_500000)),
    'fe6c48bbfdc025670f4db0340650ba5a50f9307b091d9aaa19aa44291961c69f');
  assert.equal(parseTransaction(SPEND_500000).segwit, true);

  const old = parseTransaction(LEGACY_100000);
  assert.equal(named(old),
    'fff2525b8931402dd09222c50775608f75787bd2b87e56995a7bdd30f79702c4');
  assert.equal(old.segwit, false);
  assert.equal(old.outputs.length, 2);
});

/**
 * THE REASON THE COMMITMENT IS NEEDED AT ALL.
 *
 * Section 25.1 puts the advertisement body in the witness, and the witness is
 * not covered by the txid - that is what segwit is. So a body carried there is
 * not named by the transaction, and anybody relaying the transaction can put a
 * different one in without changing what the transaction is called. Only the
 * committed output makes a body binding, and this is the measurement that says
 * so rather than the comment.
 */
test('changing the witness does not change what the transaction is called', () => {
  const before = parseTransaction(COINBASE_500000);
  const meddled = COINBASE_500000.slice();
  // the witness item of input 0 is the reserved value, near the end
  const at = meddled.length - 8;
  meddled[at] ^= 0xff;
  const after = parseTransaction(meddled);
  assert.equal(named(after), named(before));
  assert.notEqual(toHex(witnessItemsOf(after)[0]), toHex(witnessItemsOf(before)[0]));
});

test('the output commitment is read, and only from an OP_RETURN', () => {
  const tx = parseTransaction(COINBASE_500000);
  const commitments = commitmentsOf(tx);
  // one, not two: the other output is a real P2SH payment and commits to nothing
  assert.equal(commitments.length, 1);
  assert.equal(toHex(commitments[0]),
    'aa21a9ed10109f4b82aa3ed7ec9d02a2a90246478b3308c8b85daf62fe501d58d05727a4');
  assert.equal(commitments[0].length, 36);
  assert.equal(commitmentsOf(parseTransaction(SPEND_500000)).length, 0);
});

/**
 * AND THE OUTPUTS THAT LOOK LIKE ONE. This is not pedantry: a P2TR output is
 * `OP_1` and a 32-byte push, which is byte-for-byte the shape of a commitment
 * to a 32-byte hash, and a bond output IS a P2TR output. A reader that took
 * any output holding a well-formed push would read the bond's own key as the
 * advertisement it commits to - and then every bond would commit to nothing
 * and every endpoint would come from whoever offered the body.
 *
 * Measured after a mutant survived: dropping the OP_RETURN check changed
 * nothing, because the real transactions above happen to hold outputs whose
 * pushes do not fill the script.
 */
test('an output that merely looks like a push is not a commitment', () => {
  const script = (hex) => ({ outputs: [{ script: fromHex(hex) }] });
  const key = '77'.repeat(32);
  assert.equal(commitmentsOf(script('5120' + key)).length, 0);        // P2TR
  assert.equal(commitmentsOf(script('0014' + '77'.repeat(20))).length, 0);  // P2WPKH
  assert.equal(commitmentsOf(script('0020' + key)).length, 0);        // P2WSH
  // and the one that is
  assert.equal(toHex(commitmentsOf(script('6a20' + key))[0]), key);
});

test('bytes that are not exactly one transaction are refused', () => {
  const trailing = new Uint8Array(COINBASE_500000.length + 1);
  trailing.set(COINBASE_500000);
  assert.throws(() => parseTransaction(trailing), /left over/);
  assert.throws(() => parseTransaction(COINBASE_500000.slice(0, 60)), /ends inside/);
  assert.throws(() => parseTransaction(new Uint8Array(4)), /a transaction is more than/);
  assert.throws(() => parseTransaction('0100'), /a transaction is more than/);
});

/**
 * A length written the long way is a second spelling of the same transaction,
 * and the txid is a hash OF the bytes, so two spellings would be two names for
 * one thing. Bitcoin requires the short form; so does this.
 */
test('a length written longer than it needs to be is refused', () => {
  assert.equal(readVarint(fromHex('fc'), 0).value, 252);
  assert.equal(readVarint(fromHex('fdfd00'), 0).value, 253);
  assert.equal(readVarint(fromHex('fe00000100'), 0).value, 65536);
  assert.throws(() => readVarint(fromHex('fd0100'), 0), /longer than it needs/);
  assert.throws(() => readVarint(fromHex('feffff0000'), 0), /longer than it needs/);
  assert.throws(() => readVarint(fromHex('ff0000000000000000'), 0), /larger than this parser/);
});

test('hash256 is the double hash, and the same one chain.js uses', () => {
  assert.equal(toHex(hash256(new Uint8Array(0))),
    '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');
});
