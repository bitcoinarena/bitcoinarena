// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE ASKS ONLY PUBLIC DOORS (kanban #526): every path src/arena-ui/health/index.html asks a node is a GET the
// nodes document as needing no authentication (src/website/docs/endpoints.json), the page's script parses, and it never asks more than
// six requests at once with a time limit on each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/health/index.html', import.meta.url), 'utf8');
const ENDPOINTS = JSON.parse(readFileSync(new URL('../../../src/website/docs/endpoints.json', import.meta.url), 'utf8'));
const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];

test('the health page asks the nodes only public GET doors the API reference lists', () => {
  const asked = new Set();
  for (const m of script.matchAll(/['`](\/[a-z][a-z0-9./-]*)(?:\?[^'`]*)?['`]/g)) asked.add(m[1]);
  assert.ok(asked.size >= 10, `too few paths read off the page: ${[...asked]}`);
  const open = new Set(ENDPOINTS.filter((e) => e.method === 'GET' && e.auth === 'none' || e.method === 'GET' && String(e.auth).startsWith('none'))
    .flatMap((e) => String(e.path).split(/\s+\(also\s+|\)/).map((p) => p.trim()).filter((p) => p.startsWith('/'))));
  const unknown = [...asked].filter((p) => !open.has(p));
  assert.deepEqual(unknown, [], 'asked but not a public GET in endpoints.json');
});

test('the page script parses, and it limits itself: six at once, 10 s each, every 60 s', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const ASK_MS = 10000, AT_ONCE = 6;/);
  assert.match(script, /signal: AbortSignal\.timeout\(ASK_MS\)/);
  assert.match(script, /setInterval\(read, 60000\)/);
});
