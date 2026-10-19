// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The cube root, against a table.
//
// A crater's radius follows the cube root of the load, so this is the one
// place a wrong digit would make the same liquidation dig a different hole on
// a different machine. `Math.cbrt` is poisoned like every host maths
// function, so the core has its own, and its own has to be checked against
// numbers that were not produced by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONE, cbrt } from '../src/fixed.js';

// Perfect cubes: the answer is an integer and there is nothing to round.
const EXACT = [[1, 1], [8, 2], [27, 3], [64, 4], [125, 5], [216, 6],
               [1000, 10], [1728, 12], [3375, 15], [8000, 20], [27000, 30]];

test('a perfect cube comes out whole', () => {
  for (const [v, root] of EXACT)
    assert.equal(cbrt(Math.imul(v, ONE)), Math.imul(root, ONE),
      `cbrt(${v}) should be exactly ${root}`);
});

test('everything else lands on the floor, within one unit of the true root', () => {
  // Not `Math.cbrt` as the oracle - that is the function this file exists to
  // avoid. The check is the DEFINITION: y is the answer when y^3 <= x and
  // (y+1)^3 > x. Worked out in the double domain because the cube of the
  // largest root, 32.0, is 2^31 and would wrap a signed word.
  const cube = (y) => ((y * y) / ONE) * y / ONE;
  for (let v = 1; v <= 3000; v += 7) {
    const x = Math.imul(v, ONE);
    const y = cbrt(x);
    assert.ok(cube(y) <= x, `cbrt(${v}) = ${y / ONE} is too big`);
    assert.ok(cube(y + 1) > x, `cbrt(${v}) = ${y / ONE} is too small`);
  }
});

test('the largest load the core can carry still has a root', () => {
  // LIQ_MAX is 32767 millions; its root is just under 32, and 32 cubed is
  // exactly 2^31 - the edge a signed word falls off. It must not wrap.
  const y = cbrt(Math.imul(32767, ONE));
  assert.ok(y > Math.imul(31, ONE) && y < Math.imul(32, ONE),
    `root of 32767 should sit between 31 and 32, got ${y / ONE}`);
});

test('zero and below have no root, and do not throw', () => {
  assert.equal(cbrt(0), 0);
  assert.equal(cbrt(-1), 0);
  assert.equal(cbrt(-Math.imul(1000, ONE)), 0);
});

test('it is monotone - a bigger load never digs a smaller hole', () => {
  let last = -1;
  for (let v = 1; v <= 32767; v += 31) {
    const y = cbrt(Math.imul(v, ONE));
    assert.ok(y >= last, `cbrt went backwards at ${v}`);
    last = y;
  }
});
