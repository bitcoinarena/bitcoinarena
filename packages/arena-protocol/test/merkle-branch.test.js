// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT HOLDS A BLOCK CAN HAND A CLIENT THE BRANCH (M3, the page's guardian count): the
// branch `merkleBranchOf` builds rebuilds, through `merkleRootFromProof`, the root the header
// commits to - for every position of blocks of every size, odd levels included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merkleBranchOf, merkleRootFromProof, provesTransaction } from '../src/chain.js';
import { hash256 } from '../src/tx.js';
import { toHex } from '../src/hash.js';
import { blockOf } from '../tools/bond.js';

const txid = (n) => hash256(Uint8Array.from([n]));

test('every position of blocks of 1 to 9 transactions proves into its mined header, and no other position does', () => {
  let proven = 0;
  for (let size = 1; size <= 9; size++) {
    const txids = Array.from({ length: size }, (_, i) => txid(size * 16 + i));
    const { header, root } = blockOf(hash256, txids);
    for (let p = 0; p < size; p++) {
      const branch = merkleBranchOf(txids, p);
      assert.equal(toHex(merkleRootFromProof(txids[p], branch, p)), toHex(root), `size ${size} position ${p}`);
      assert.equal(provesTransaction(header, txids[p], branch, p), true);
      if (size > 1) assert.equal(provesTransaction(header, txids[(p + 1) % size], branch, p), false, 'the branch proved another transaction');
      proven++;
    }
  }
  assert.equal(proven, 45);
  assert.throws(() => merkleBranchOf([txid(1)], 1), /no transaction at position 1 of 1/);
});
