// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2623: the season draw is deterministic from its published inputs - the entry list and a block hash - whatever order the list comes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { draw, PLACES_SATS } from '../tools/bounty-draw.mjs';

const HASH = '00000000000000000001a8b3c0f2b1a47a9d3f0b1e2c4d5e6f708192a3b4c5d6';
const ENTRIES = ['telegram:@ann', 'discord:bob', 'telegram:@cat', 'discord:dan', 'telegram:@eve', 'discord:fay', 'telegram:@gus'];

test('#2623 the draw: 5 distinct winners, the places 20k/12k/8k/6k/4k, the same for any order and duplicates', () => {
  const a = draw(ENTRIES, HASH);
  const b = draw([...ENTRIES].reverse().concat(['discord:bob', ' telegram:@ann ', '']), HASH.toUpperCase());
  assert.deepEqual(a, b);
  assert.equal(a.winners.length, 5);
  assert.equal(new Set(a.winners.map((w) => w.entry)).size, 5);
  assert.deepEqual(a.winners.map((w) => w.sats), [...PLACES_SATS]);
  assert.equal(a.entries.length, 7);
  // the first place by hand: sha256("<hash>:1") mod 7 over the sorted list
  const sorted = [...ENTRIES].sort();
  const k = Number(BigInt(`0x${createHash('sha256').update(`${HASH}:1`).digest('hex')}`) % 7n);
  assert.equal(a.winners[0].entry, sorted[k]);
  assert.notDeepEqual(draw(ENTRIES, HASH.replace(/6$/, '7')).winners, a.winners, 'another block, another draw');
  assert.equal(draw(['only:one'], HASH).winners.length, 1);
  assert.throws(() => draw(ENTRIES, 'abc'), /block hash/);
});
