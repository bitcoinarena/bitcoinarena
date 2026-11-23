// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SPLIT BLOCK IS VIEWS OF ITS ONE BUFFER (kanban #3238): a seat keeps every block of its census window, and a copied buffer per
// transaction was one small native allocation each - the malloc fragmentation of a seat's ~0.9 GB native memory. The header and every
// transaction lie in the block's own bytes, with the same bytes the copying split gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { splitBlock } from '../src/block.js';
import { readVarint } from '../src/tx.js';
import { fromHex, toHex } from '../src/hash.js';

const RAW = fromHex(readFileSync(new URL('./fixtures/regtest-block.hex', import.meta.url), 'utf8').trim());

test('#3238 a block\'s header and transactions are views of the block\'s one buffer, byte for byte as the copies were', () => {
  const block = splitBlock(RAW);
  assert.ok(block.transactions.length >= 4);
  const buffers = new Set([block.header.buffer, ...block.transactions.map((t) => t.buffer)]);
  assert.equal(buffers.size, 1, 'one ArrayBuffer under the whole block');
  assert.equal(block.header.buffer, RAW.buffer);
  assert.equal(toHex(block.header), toHex(RAW.slice(0, 80)));
  let at = readVarint(RAW, 80).next;
  for (const t of block.transactions) {
    assert.equal(t.byteOffset, RAW.byteOffset + at, 'each transaction follows the one before it in the block');
    assert.equal(toHex(t), toHex(RAW.slice(at, at + t.length)));
    at += t.length;
  }
  assert.equal(at, RAW.length);
});

test('#3238 a block read inside a larger buffer stays inside its own bytes', () => {
  const outer = new Uint8Array(RAW.length + 10); outer.set(RAW, 5);
  const inner = outer.subarray(5, 5 + RAW.length);
  const block = splitBlock(inner);
  for (const t of [block.header, ...block.transactions]) {
    assert.ok(t.byteOffset >= 5 && t.byteOffset + t.byteLength <= 5 + RAW.length);
  }
  assert.deepEqual(block.transactions.map(toHex), splitBlock(RAW).transactions.map(toHex));
});
