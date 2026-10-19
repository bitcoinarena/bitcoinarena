// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY DOOR IS IN THE API REFERENCE (2026-10-18: "update docs and api with all changes"): six routes of 10-17/18
// (/gateway/*, /gateway-claim, /liquidity-claim, /liquidity-seating, /gateway-seating, /gateway-seats, /owner/liquidity/new-address)
// were served but missing from src/website/docs/endpoints.json, so docs.bitcoin-arena.io/api did not list them. A route server.js
// answers by exact path or prefix must have an entry there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const listed = JSON.parse(readFileSync(new URL('../../../src/website/docs/endpoints.json', import.meta.url), 'utf8')).map((e) => e.path.toLowerCase());

test('every path server.js answers is listed in the API reference (src/website/docs/endpoints.json)', () => {
  const served = new Set();
  for (const m of src.matchAll(/(?:pathname|path|p)\s*===\s*'(\/[^']*)'/g)) served.add(m[1]);
  for (const m of src.matchAll(/startsWith\('(\/[^']*)'\)/g)) served.add(m[1]);
  assert.ok(served.size > 150, `the scan finds the doors (${served.size})`);
  const missing = [...served].filter((p) => { const q = p.toLowerCase().replace(/\/$/, ''); return !listed.some((h) => h === q || h.startsWith(q)); });
  assert.deepEqual(missing, [], 'served but not in endpoints.json');
});
