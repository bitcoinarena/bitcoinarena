// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME'S CLIENT READS THE PAGE UNDER ARENA'S NAMES (kanban #523): ARENA_JOIN, ARENA_JOIN_ANSWER and ARENA_ROW_NODES are the page's
// BLWP_JOIN, BLWP_JOIN_ANSWER and BLWP_ROW_NODES - the same values, read live - so a new client version reads the new names while the
// versions already played keep the old ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');

test('ARENA_JOIN, ARENA_JOIN_ANSWER and ARENA_ROW_NODES read the BLWP_ values live', () => {
  const at = PAGE.indexOf("    ['JOIN', 'JOIN_ANSWER', 'ROW_NODES'].forEach(");
  assert.ok(at > 0, 'the page names no ARENA_ aliases');
  const src = PAGE.slice(at, PAGE.indexOf('    });\n', at) + 8);
  const window = {};
  new Function('window', src)(window);
  const nodes = () => ['a'];
  Object.assign(window, { BLWP_JOIN: { state: 'joining' }, BLWP_JOIN_ANSWER: { ok: true }, BLWP_ROW_NODES: nodes });
  assert.deepEqual(window.ARENA_JOIN, { state: 'joining' });
  assert.deepEqual(window.ARENA_JOIN_ANSWER, { ok: true });
  assert.equal(window.ARENA_ROW_NODES, nodes);
  window.BLWP_JOIN = { state: 'joined' };
  assert.equal(window.ARENA_JOIN.state, 'joined', 'read live, not copied once');
});
