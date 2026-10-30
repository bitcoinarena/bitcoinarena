// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RESERVE KEY KEPT FOR AN EARLIER SET OF GUARDIAN SEATS IS NOT THE FEDERATION'S KEY NOW (kanban #803, measured 2026-10-30 07:3xZ, round
// e994c3c4: second-host seat 5 refused the entry's reserve output to 02efa760… against 02ef0576…, the key it had kept from an earlier epoch while
// its own share for the current epoch 296aff8c was 02efa760…). reserve-key-cache.js: a kept key answers only for its own epoch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveKeyCache } from '../src/reserve-key-cache.js';

const B = '4dc88be7'.padEnd(64, '0');
const OLD = Uint8Array.from([2, 0xef, 0x05, 0x76]), NOW = Uint8Array.from([2, 0xef, 0xa7, 0x60]);

test('a key kept under an earlier epoch is not answered for the current one; it is read anew and kept under the new epoch', () => {
  const c = reserveKeyCache();
  c.setFor(B, 'epoch-earlier', OLD);
  assert.equal(c.getFor(B, 'epoch-earlier'), OLD, 'its own epoch: kept');
  assert.equal(c.getFor(B, '296aff8c'), null, 'the guardian seats changed: not this key (second-host seat 5 checked the lock against it)');
  c.setFor(B, '296aff8c', NOW);
  assert.equal(c.getFor(B, '296aff8c'), NOW);
  assert.equal(c.getFor(B, null), NOW, 'a seat that cannot tell the epoch takes the key it keeps');
});

test('the reserve pass lets go of every key whose federation moved, and keeps one it cannot tell or that did not move', () => {
  const c = reserveKeyCache();
  const A = '337ae01a'.padEnd(64, '0'), O = 'b18947f0'.padEnd(64, '0');
  c.setFor(B, 'epoch-earlier', OLD); c.setFor(A, 'a1', NOW); c.setFor(O, 'o1', NOW);
  const gone = c.dropMoved((f) => ({ [B]: '296aff8c', [A]: 'a1' })[f] || null);
  assert.deepEqual(gone, [B]);
  assert.equal(c.get(B), undefined, 'no reader of the cache sees the moved key any more');
  assert.equal(c.get(A), NOW); assert.equal(c.get(O), NOW, 'an epoch this seat cannot tell keeps its key');
  assert.deepEqual([...c.keys()].sort(), [A, O].sort());
  assert.equal([...c.values()].length, 2, 'values() reads as the Map it replaces');
});

test('a federation left with no guardian seats lets go of its kept key (test host seat 4, 10-30: 02533d74 for federation A, 0 members)', () => {
  const c = reserveKeyCache();
  const A = '337ae01a'.padEnd(64, '0');
  c.setFor(A, 'a-before', OLD); c.setFor(B, '296aff8c', NOW);
  const guards = { [B]: true };   // the reserve pass reads A as 'none' - no guardian seats, so no epoch of any key
  assert.deepEqual(c.dropMoved((f) => (guards[f] ? '296aff8c' : 'none')), [A]);
  assert.equal(c.get(A), undefined); assert.equal(c.get(B), NOW);
});
