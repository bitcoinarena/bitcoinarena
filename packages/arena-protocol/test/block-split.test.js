// A BLOCK AS A NODE SERVES IT, SPLIT INTO ITS TRANSACTIONS.
//
// `parseTransaction` refuses leftover bytes - a transaction handed over with
// something after it is not one anybody agreed on - so it cannot be pointed at
// the middle of a block. Until this there was no way to turn `getblock ... 0`
// into the view the census takes, which is why every census measurement ran on
// blocks a fixture composed.
//
// The bytes here are a real regtest block from bitcoin-31.1: a coinbase and
// three bond funding transactions, each spending a taproot script path whose
// witness carries the advertisement body (5A.2). Written out by
// `arena-node/tools/census-regtest.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTransaction, blockMerkleRoot, commitmentsOf, witnessItemsOf } from '../src/tx.js';
import { splitBlock } from '../src/block.js';
import { toHex, fromHex } from '../src/hash.js';

const RAW = fromHex(readFileSync(new URL('./fixtures/regtest-block.hex', import.meta.url), 'utf8').trim());

test('a real block splits into a header and the transactions its header commits to', () => {
  const { header, transactions } = splitBlock(RAW);

  assert.equal(header.length, 80);
  assert.equal(transactions.length, 4, 'a coinbase and three bond fundings');

  // THE SPLIT IS NOT TRUSTED, IT IS CHECKED. A span computed one byte wrong
  // gives a different txid, and the merkle root the block's own header carries
  // refuses it. This is the same check `chainViewOf` runs.
  const ids = transactions.map((raw) => parseTransaction(raw).txid);
  assert.deepEqual(toHex(blockMerkleRoot(ids)), toHex(header.slice(36, 68)));

  // and every byte of the block is accounted for: the pieces put back together
  // are the block again
  const rejoined = transactions.reduce((n, t) => n + t.length, 0);
  assert.equal(rejoined + 80 + 1, RAW.length, 'the split lost or invented bytes');
});

test('the bonds in it carry their advertisement in the witness, as 5A.2 says', () => {
  const { transactions } = splitBlock(RAW);
  const bonds = transactions.slice(1).map((raw) => parseTransaction(raw));

  for (const tx of bonds) {
    const commitments = commitmentsOf(tx);
    assert.equal(commitments.length, 1, 'a bond commits to one advertisement');
    assert.equal(commitments[0].length, 32);
    // the body rides in the witness of the same transaction, and it is the
    // large item - the signature and the leaf script are the small ones
    const items = witnessItemsOf(tx);
    assert.equal(items.some((i) => i.length > 100), true,
      'no witness item large enough to be an advertisement body');
  }
});

test('a block that does not add up is refused, not truncated', () => {
  assert.throws(() => splitBlock(RAW.slice(0, RAW.length - 1)), /ends inside its locktime/);
  assert.throws(() => splitBlock(new Uint8Array([...RAW, 0x00])), /1 bytes left over after 4 transactions/);
  assert.throws(() => splitBlock(RAW.slice(0, 40)), /a block is more than 40 bytes/);

  // A COUNT THAT PROMISES MORE THAN IS THERE. The count is one byte at offset
  // 80 in this block, so claiming five transactions runs off the end.
  const lying = new Uint8Array(RAW);
  lying[80] = 5;
  assert.throws(() => splitBlock(lying), /length|version|outpoint|left over/);
});
