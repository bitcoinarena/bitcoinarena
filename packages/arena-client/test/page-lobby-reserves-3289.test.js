// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3289: the lobby's first paint asked the seats' /reserves, waited up to 1.5 s for them, and only then asked the rounds (measured on
// the live page 2026-11-22: two silent seats, 1.5 s before any GET /rounds left). The rounds are asked beside the reserves; the first draw
// still waits for the reserves or 1.5 s, so a table of a keyless federation is held back as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const paint = src.slice(src.indexOf('const paint = async () => {'), src.indexOf('const draw = (got, got2) =>'));

test('the rounds are asked before the reserves are awaited', () => {
  assert.ok(paint.length > 1000, 'paint found');
  const ask = paint.indexOf('const pMine = read(named.nodes);');
  assert.ok(ask > 0);
  assert.doesNotMatch(paint.slice(0, ask), /await Promise\.race\(\[k\.asking/, 'no wait before the rounds are asked');
});

test('each draw waits for the reserves gate (or its 1.5 s), and the paint waits for both draws', () => {
  assert.match(paint, /reservesGate = Promise\.race\(\[k\.asking, new Promise\(\(ok\) => setTimeout\(ok, 1500\)\)\]\)/);
  assert.match(paint, /pMine\.then\(async \(g\) => \{ await reservesGate; mineGot = g; draw\(/);
  assert.match(paint, /pTheirs\.then\(async \(g\) => \{ await reservesGate; theirsGot = g;/);
  assert.match(paint, /await Promise\.allSettled\(\[dMine, dTheirs\]\)/);
});
