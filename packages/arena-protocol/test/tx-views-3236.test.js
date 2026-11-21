// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PARSE'S BYTE FIELDS ARE VIEWS OF THE RAW TRANSACTION (kanban #3236): the same values as the copying parse before, field by field,
// on the regtest block's coinbase and bond transactions - and each script, witness item and previous txid lies inside the raw's own buffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTransaction, readVarint, hash256, commitmentsOf, witnessRunsOf } from '../src/tx.js';
import { splitBlock } from '../src/block.js';
import { fromHex, toHex } from '../src/hash.js';

const RAW = fromHex(readFileSync(new URL('./fixtures/regtest-block.hex', import.meta.url), 'utf8').trim());
const TXS = splitBlock(RAW).transactions;

// The parse as it was before #3236, every byte field its own copy (tx.js slice).
function copyingParse(raw) {
  const u32 = (at) => (raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16) | (raw[at + 3] << 24)) >>> 0;
  const slice = (at) => { const { value, next } = readVarint(raw, at); return { bytes: raw.slice(next, next + value), next: next + value }; };
  let at = 4;
  const segwit = raw[4] === 0x00 && raw[5] === 0x01;
  if (segwit) at += 2;
  const bodyFrom = at;
  const ins = readVarint(raw, at); at = ins.next;
  const inputs = [];
  for (let i = 0; i < ins.value; i++) {
    const previousTxid = raw.slice(at, at + 32), previousVout = u32(at + 32);
    const script = slice(at + 36); at = script.next + 4;
    inputs.push({ previousTxid, previousVout, script: script.bytes });
  }
  const outs = readVarint(raw, at); at = outs.next;
  const outputs = [];
  for (let i = 0; i < outs.value; i++) {
    let value = 0n;
    for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(raw[at + b]);
    const script = slice(at + 8); at = script.next;
    outputs.push({ value, script: script.bytes });
  }
  const bodyTo = at;
  const witnesses = [];
  if (segwit) for (let i = 0; i < inputs.length; i++) {
    const n = readVarint(raw, at); at = n.next;
    const stack = [];
    for (let k = 0; k < n.value; k++) { const item = slice(at); at = item.next; stack.push(item.bytes); }
    witnesses.push(stack);
  }
  const stripped = new Uint8Array(4 + (bodyTo - bodyFrom) + 4);
  stripped.set(raw.subarray(0, 4), 0); stripped.set(raw.subarray(bodyFrom, bodyTo), 4); stripped.set(raw.subarray(at, at + 4), 4 + (bodyTo - bodyFrom));
  return { version: u32(0), segwit, inputs, outputs, witnesses, locktime: u32(at), txid: hash256(stripped) };
}

const inside = (view, raw) => view.buffer === raw.buffer && view.byteOffset >= raw.byteOffset
  && view.byteOffset + view.byteLength <= raw.byteOffset + raw.byteLength;

test('#3236 a parse equals the copying parse, field by field', () => {
  assert.ok(TXS.length >= 4 && TXS.some((t) => parseTransaction(t).witnesses.some((s) => s.length >= 4)), 'the block holds bond transactions with a split witness');
  for (const raw of TXS) {
    const got = parseTransaction(raw), was = copyingParse(raw);
    assert.equal(got.version, was.version); assert.equal(got.segwit, was.segwit); assert.equal(got.locktime, was.locktime);
    assert.equal(toHex(got.txid), toHex(was.txid));
    assert.equal(got.inputs.length, was.inputs.length);
    got.inputs.forEach((x, i) => {
      assert.equal(toHex(x.previousTxid), toHex(was.inputs[i].previousTxid)); assert.equal(x.previousVout, was.inputs[i].previousVout);
      assert.equal(toHex(x.script), toHex(was.inputs[i].script));
      assert.ok(x.previousTxid instanceof Uint8Array && x.script instanceof Uint8Array);
    });
    assert.equal(got.outputs.length, was.outputs.length);
    got.outputs.forEach((o, i) => { assert.equal(o.value, was.outputs[i].value); assert.equal(toHex(o.script), toHex(was.outputs[i].script)); });
    assert.deepEqual(got.witnesses.map((s) => s.map(toHex)), was.witnesses.map((s) => s.map(toHex)));
    assert.deepEqual(commitmentsOf(got).map(toHex), commitmentsOf(was).map(toHex));
    assert.deepEqual(witnessRunsOf(got).map(toHex), witnessRunsOf(was).map(toHex));
  }
});

test('#3236 the byte fields share the raw buffer, and a commitment is still its own copy', () => {
  for (const raw of TXS) {
    const tx = parseTransaction(raw);
    for (const x of tx.inputs) { assert.ok(inside(x.previousTxid, raw)); assert.ok(inside(x.script, raw)); }
    for (const o of tx.outputs) assert.ok(inside(o.script, raw));
    for (const s of tx.witnesses) for (const item of s) assert.ok(inside(item, raw));
    assert.ok(!inside(tx.txid, raw));
    for (const c of commitmentsOf(tx)) assert.ok(!inside(c, raw));
  }
  // a raw that is a view into a larger buffer: the fields are views of that same region
  const big = new Uint8Array(TXS[1].length + 16); big.set(TXS[1], 7);
  const sub = big.subarray(7, 7 + TXS[1].length), tx = parseTransaction(sub);
  assert.equal(toHex(tx.txid), toHex(parseTransaction(TXS[1]).txid));
  for (const o of tx.outputs) assert.ok(inside(o.script, sub));
});
