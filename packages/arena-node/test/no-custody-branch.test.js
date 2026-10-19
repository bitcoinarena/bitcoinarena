// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE ASKS NO ROUND WHICH CUSTODY IT HAS (RULED 2026-09-24, the enum slice's third cut).
//
// Every contract a signer node reads has come through decodeRoundContract, which answers FEDERATION or throws: a
// `custody === 'FEDERATION'` there is always true, and its other side was the withdrawn custody's branch. This is a
// SOURCE-LEVEL test, not a behaviour test - no door can reach that other branch, so no behaviour can go red first. It
// reads the node's src and fails on any comparison against a custody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The node's src, and since the fourth cut (RULED 2026-09-24) the codec's and the page's too.
const SRCS = [join(here, '..', 'src'), join(here, '..', '..', 'arena-protocol', 'src'), join(here, '..', '..', 'arena-client', 'src')];

test('no file in the node\'s, the codec\'s or the page\'s src compares a round\'s custody to anything', () => {
  const found = [];
  for (const src of SRCS) for (const f of readdirSync(src).filter((n) => /\.m?js$/.test(n))) {
    readFileSync(join(src, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\.custody\s*[!=]==?|[!=]==?\s*[\w.]*\.custody\b/.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  console.log('  FACTS:', JSON.stringify({ comparisons: found.length, found }));
  assert.deepEqual(found, [], 'the node still branches on custody');
});
