// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WITHDRAWN CUSTODY IS GONE FROM THE SCRIPT THE PAGE RUNS, TOO (§23.6, RULED 2026-09-22 22:59; this cut
// RULED 2026-09-24: "decoding a byte-0 contract must throw the same sentence the source throws ... the bundle text must
// not contain THRESHOLD_LN").
//
// The source has refused byte 0 since cut 2 (protocol custody-byte.test, arena-node withdrawn-custody-absent.test), but
// the page does not run the source: it runs the pinned bundle, dist/arena-client.js, and the WebGL template's copy of
// it. MEASURED before this test (2026-09-24): the same byte-0 contract that the source refuses decoded in the bundle as
// { custody: 'THRESHOLD_LN' } - its CUSTODY table still read ['THRESHOLD_LN', 'FEDERATION'].
//
// Both copies are checked: dist is what the build commits, the template's is what the page loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { contractFor } from '../../arena-node/test/window-fixture.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';

const require = createRequire(import.meta.url);
const ROOT = new URL('../../../', import.meta.url).pathname;
const COPIES = [
  ['dist', ROOT + 'packages/arena-client/dist/arena-client.js'],
  ['the WebGL template', ROOT + 'src/arena-ui/arena-client.js'],
];

/** One fixture contract with its custody byte set to 0, and the sentence the source throws for it. */
function byteZero() {
  const bytes = encodeRoundContract(contractFor([new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)], 3000n));
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 1) continue;
    const zero = bytes.slice();
    zero[i] = 0;
    try { decodeRoundContract(zero); } catch (e) { if (/custody/.test(e.message)) return { zero, sentence: e.message }; }
  }
  throw new Error('no custody byte found in the fixture contract');
}

test('the bundle the page runs refuses a byte-0 contract with the sentence the source throws - in dist and in the WebGL template', () => {
  const { zero, sentence } = byteZero();
  assert.match(sentence, /^custody byte 0 is not a custody of this network/);
  const said = {};
  for (const [where, path] of COPIES) {
    const bundle = require(path);
    try { said[where] = { decoded: bundle.decodeRoundContract(zero).custody }; } catch (e) { said[where] = { threw: e.message }; }
  }
  console.log('  FACTS (byte 0 in the bundle):', JSON.stringify({ source: sentence, ...said }));
  for (const [where] of COPIES) assert.deepEqual(said[where], { threw: sentence }, `${where}: byte 0 is not refused as the source refuses it`);
});

test('the bundle the page runs does not name the withdrawn custody anywhere - in dist and in the WebGL template', () => {
  const named = COPIES.filter(([, path]) => readFileSync(path, 'utf8').includes('THRESHOLD_LN')).map(([where]) => where);
  assert.deepEqual(named, [], `the bundle text names THRESHOLD_LN: ${named.join(', ')}`);
});
