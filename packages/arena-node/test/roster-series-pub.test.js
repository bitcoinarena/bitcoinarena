// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SERIES PUBLICATION, FOUND WITH EACH BLOCK READ ONCE (the load, 2026-10-15): roster.js findSeriesPublication answers
// as series.js's does - the lowest block of the view carrying the series' payload, by height - and reads a block's transactions
// only the first time it is asked about that block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSeriesPublication } from '../src/roster.js';
import { findSeriesPublication as protocolFind, seriesPublicationOutput } from '../../arena-protocol/src/series.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const le = (n, bytes) => { const o = new Uint8Array(bytes); let v = BigInt(n); for (let i = 0; i < bytes; i++) { o[i] = Number(v & 255n); v >>= 8n; } return o; };
const txWith = (outputs, salt = 0) => Uint8Array.from([...le(2, 4), 1, ...b32(salt), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outputs.length, ...outputs.flatMap((o) => [...le(o.value, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const payTo = { value: 1000n, script: Uint8Array.from([0x51, 0x20, ...b32(0x77)]) };

test('roster findSeriesPublication: the same heights as series.js, each block\'s transactions read once', () => {
  const id = b32(0x31), other = b32(0x32), absent = b32(0x33);
  let reads = 0;
  const block = (txs) => ({ get transactions() { reads++; return txs; } });
  const view = { firstHeight: 500, blocks: [
    block([Uint8Array.from([1, 2, 3]), txWith([payTo], 2)]),          // 500: garbage, an unrelated tx
    block([txWith([seriesPublicationOutput(other)], 3)]),             // 501: another series
    block([txWith([payTo, seriesPublicationOutput(id)], 1)]),         // 502: the publication
    block([txWith([seriesPublicationOutput(id)], 4)]),                // 503: a later copy
  ] };
  for (const sid of [id, other, absent]) {
    const want = protocolFind(view, sid);
    const got = findSeriesPublication(view, sid);
    assert.deepEqual(got && got.height, want && want.height);
  }
  const afterFirst = reads;
  // every round of a grid asks again, over views that hold the same block objects: nothing is read again
  for (let n = 0; n < 50; n++) { findSeriesPublication(view, id); findSeriesPublication({ firstHeight: 500, blocks: view.blocks.slice(0, 3) }, other); }
  console.log('  READS:', JSON.stringify({ afterFirst, after100More: reads }));
  assert.equal(reads - afterFirst, 0, 'a block was read again');
  assert.equal(findSeriesPublication({ firstHeight: 500, blocks: view.blocks.slice(0, 2) }, id), null);
  assert.equal(findSeriesPublication(undefined, id), null);
  assert.equal(findSeriesPublication({ firstHeight: 500.5, blocks: view.blocks }, id), null);
  assert.equal(findSeriesPublication({ firstHeight: 500, blocks: [{}] }, id), null, 'a block with no transactions');
  // a NEW block object (another hash at a height) is read once, and answers by its own transactions
  const moved = { firstHeight: 500, blocks: [...view.blocks.slice(0, 2), block([txWith([payTo], 9)]), view.blocks[3]] };
  assert.equal(findSeriesPublication(moved, id).height, 503);
});
