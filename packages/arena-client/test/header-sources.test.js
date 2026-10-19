// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CHAIN FROM A FEW SOURCES, NOT FROM EVERY SEAT (2026-10-16: "Lower the amount of concurrent connections
// and network load"; measured on preview UI 153: every PLAY read /headers (218800 bytes) from all 14 seats at once, and a busy tab
// had none of the 14 inside 10 s - "no chain: only 0 of 14 providers gave a chain")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerSources, HEADER_SOURCES_ASKED } from '../src/join.js';

const seats = [...Array.from({ length: 7 }, (_, i) => `https://tn4.example/guardian-${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `https://tn4.example/fed2-${i + 1}/`)];

test('a join asks HEADER_SOURCES_ASKED distinct sources of the fourteen, not all of them', () => {
  const got = headerSources(seats);
  assert.equal(HEADER_SOURCES_ASKED, 4);
  assert.equal(got.length, 4);
  assert.equal(new Set(got).size, 4);
  for (const u of got) assert.ok(seats.includes(u));
});
test('picked at random, so the pages spread over the seats', () => {
  const seen = new Set();
  for (let k = 0; k < 200; k++) for (const u of headerSources(seats)) seen.add(u);
  assert.equal(seen.size, 14, 'every seat is asked by some page');
});
test('one source listed twice counts once; never fewer than the two a chain needs', () => {
  assert.deepEqual(headerSources(['https://a.example/x', 'https://a.example/x/', 'https://b.example/y'], { random: () => 0 }).length, 2);
  assert.equal(headerSources(seats.slice(0, 3), { n: 1 }).length, 2);
});
