// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EQUAL VALUES, ONE OBJECT, NOTHING ELSE CHANGED (kanban #927).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInterner } from '../src/intern.js';

const b = (n, len = 32) => new Uint8Array(len).fill(n);

test('equal bytes and texts become one object, and nothing reads differently', () => {
  const { share } = createInterner();
  const one = share({ a: b(1), nodes: [b(2), b(3)], deep: { x: b(1) }, relays: ['wss://r'], n: 5, big: 7n, none: null });
  const two = share({ a: b(1), nodes: [b(2), b(4)], deep: { x: b(9) }, relays: ['wss://r'], n: 5, big: 7n, none: null });
  assert.equal(one.a, two.a);
  assert.equal(one.a, one.deep.x);
  assert.equal(one.nodes[0], two.nodes[0]);
  assert.notEqual(one.nodes[1], two.nodes[1]);
  assert.deepEqual(one, { a: b(1), nodes: [b(2), b(3)], deep: { x: b(1) }, relays: ['wss://r'], n: 5, big: 7n, none: null });
  assert.deepEqual(two.nodes[1], b(4));
});

test('bytes that share a buffer are told apart by their own window', () => {
  const { share } = createInterner();
  const whole = Uint8Array.from([1, 2, 3, 4]);
  const a = share(whole.subarray(0, 2)), c = share(whole.subarray(2, 4)), again = share(Uint8Array.from([1, 2]));
  assert.notEqual(a, c);
  assert.equal(a, again);
  assert.deepEqual([...c], [3, 4]);
});

test('past its bound the table starts again: a value is never lost or mixed up', () => {
  const { share, sizes } = createInterner({ most: 4 });
  const seen = [];
  for (let i = 0; i < 20; i++) seen.push(share(b(i)));
  assert.ok(sizes().bytes <= 4);
  seen.forEach((u, i) => assert.equal(u[0], i));
});

test('long values are left alone, as are class instances', () => {
  const { share } = createInterner();
  const long = new Uint8Array(200).fill(1), when = new Date(0);
  assert.equal(share(long), long);
  assert.notEqual(share(new Uint8Array(200).fill(1)), long);
  assert.equal(share(when), when);
});
