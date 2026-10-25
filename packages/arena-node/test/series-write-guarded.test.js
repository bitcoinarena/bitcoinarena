// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SERIES THE SEAT CANNOT OPEN STOPS ONLY ITSELF (2026-10-25 ~10:20Z: a Next Block series naming a core no seat held threw out of
// Round.open in the series writer, and every seat crashed at each start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeGuarded } from '../src/series-writer.js';

test('a writer that throws is left out, said once, and does not ask for more; the others go on', () => {
  const said = [];
  let asked = 0;
  const bad = { id: new Uint8Array(32).fill(0x87), more: true, write: () => { asked++; throw new Error('this signer node holds no core a5c5766a7902b670'); } };
  const good = { id: new Uint8Array(32).fill(1), more: false, write: () => 4 };
  assert.equal(writeGuarded(bad, 1000, 2000, (l) => said.push(l)), 0);
  assert.equal(bad.more, false, 'no "more": the writer loop is not kept busy by it');
  assert.match(said[0], /^\[series\] 8787878787878787: not written here \(left out until the next start\): this signer node holds no core a5c5766a/);
  assert.equal(writeGuarded(bad, 1000, 2000, (l) => said.push(l)), 0);
  assert.deepEqual([asked, said.length], [1, 1], 'asked once, said once');
  assert.equal(writeGuarded(good, 1000, 2000, (l) => said.push(l)), 4, 'another series is written as before');
});
