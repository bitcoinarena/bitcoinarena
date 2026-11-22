// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MEMORY CUTS OF A SEAT'S HEAP SNAPSHOT (kanban #3236), each held to the answers it gave before: the txid index per block (roster.js
// whereInView), the seated keys as one string each (seating-agent.js seatedHexOf), the used round ids keyed by their bytes (transcript-prune.js idKey).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { whereInView } from '../src/roster.js';
import { seatedHexOf } from '../src/seating-agent.js';
import { idKey } from '../src/transcript-prune.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const TXS = splitBlock(fromHex(readFileSync(new URL('../../arena-protocol/test/fixtures/regtest-block.hex', import.meta.url), 'utf8').trim())).transactions;

// the per-view index as roster.js built it before #3236
function oldIndex(view) {
  const where = new Map();
  for (const block of (view && Array.isArray(view.blocks) ? view.blocks : [])) {
    let txids;
    try { txids = (block.transactions || []).map((raw) => parseTransaction(raw).txid); } catch { continue; }
    txids.forEach((t, position) => where.set(toHex(t), { block, txids, position }));
  }
  return where;
}

test('#3236 whereInView answers what the per-view index answered, and views share a block\'s index', () => {
  const a = { transactions: TXS.slice(0, 2) }, b = { transactions: TXS.slice(1) }, bad = { transactions: [TXS[2], new Uint8Array(12)] };
  const c = { transactions: [TXS[3]] };
  const v1 = { blocks: [a, bad, b] }, v2 = { blocks: [b, c] }, none = { blocks: null };
  const asked = [...TXS.map((t) => toHex(parseTransaction(t).txid)), 'ff'.repeat(32)];
  for (const view of [v1, v2, none]) {
    const old = oldIndex(view);
    for (const h of asked) for (let n = 0; n < 2; n++) {
      const got = whereInView(view, h), was = old.get(h);
      if (!was) { assert.equal(got, undefined); continue; }
      assert.equal(got.block, was.block); assert.equal(got.position, was.position);
      assert.deepEqual(got.txids.map(toHex), was.txids.map(toHex));
    }
  }
  // TXS[1] is in a and in b: the newest block (b) answers, as before
  assert.equal(whereInView(v1, asked[1]).block, b);
  // one index per block: two views that hold b answer with b's one txid list
  assert.equal(whereInView(v1, asked[2]).txids, whereInView(v2, asked[2]).txids);
  assert.equal(whereInView(null, asked[0]), undefined);
});

test('#3236 a seated key is its hex, the same string for equal keys', () => {
  const k = fromHex('02' + 'ab'.repeat(32));
  assert.equal(seatedHexOf(k), toHex(k));
  assert.equal(seatedHexOf(Uint8Array.from(k)), seatedHexOf(k));
  assert.notEqual(seatedHexOf(fromHex('03' + 'ab'.repeat(32))), seatedHexOf(k));
});

test('#3236 a round id key: equal bytes one key, distinct bytes distinct, a text id never a blob one', () => {
  const id = fromHex('00ff7f80'.repeat(8));
  assert.equal(idKey(id), idKey(Uint8Array.from(id)));
  assert.equal(idKey(id).length, 33);
  const big = new Uint8Array(40); big.set(id, 5);
  assert.equal(idKey(big.subarray(5, 37)), idKey(id));
  assert.notEqual(idKey(id), idKey(fromHex('00ff7f80'.repeat(7) + '00ff7f81')));
  assert.notEqual(idKey(new Uint8Array(0)), idKey(''));
  assert.notEqual(idKey(toHex(id)), idKey(id));
  const keys = new Set();
  for (let i = 0; i < 256; i++) keys.add(idKey(Uint8Array.of(i))), keys.add(idKey(Uint8Array.of(0, i)));
  assert.equal(keys.size, 512);
  assert.equal(idKey(7), 'o7');
});
