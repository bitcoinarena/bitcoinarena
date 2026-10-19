// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO NAME server.js IMPORTS IS DECLARED AGAIN INSIDE IT (2026-10-15 11:38Z): a `const endpointsOf` added inside
// serve() shadowed roster.js's endpointsOf (a committee -> the seats' URLs) for the whole function, so every verifier's peersFor
// answered with the new function's object and each head-to-head close threw "this.peersOf is not a function or its return value is
// not iterable" - five testnet4 seats restarted in a loop. The suite's server tests never close a head-to-head round; this reads
// the file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('server.js declares none of the names it imports', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const imported = new Set();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from/gm))
    for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop().trim(); if (name) imported.add(name); }
  for (const m of src.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gm)) imported.add(m[1]);
  // KNOWN AND NARROW: `stateOf` (settlement-state.js) is declared again as an entry's state inside one nested function (the FINAL
  // gathering, near its uses) and read only there - not the shape that broke the seats (a declaration in serve()'s own scope)
  const ALLOWED = new Set(['stateOf']);
  const again = [];
  for (const m of src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\b/g)) if (imported.has(m[1]) && !ALLOWED.has(m[1])) again.push(m[1]);
  console.log('  IMPORTS:', imported.size, 'declared again:', JSON.stringify([...new Set(again)]));
  assert.deepEqual([...new Set(again)], [], 'an imported name is declared again in server.js and shadows the import');
});
