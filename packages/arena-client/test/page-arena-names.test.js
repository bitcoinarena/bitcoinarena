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
  const at = PAGE.indexOf("    ['JOIN', 'JOIN_ANSWER', 'ROW_NODES', ");
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

test('every name Unity\'s bridge reads or writes as ARENA_* is the page\'s BLWP_* value, both ways (kanban #524)', () => {
  const at = PAGE.indexOf("    ['JOIN', 'JOIN_ANSWER', 'ROW_NODES', ");
  const src = PAGE.slice(at, PAGE.indexOf('    });\n', at) + 8);
  const window = {};
  new Function('window', src)(window);
  const jslib = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  const used = [...new Set([...jslib.matchAll(/\bARENA_([A-Z][A-Z_]*)\b/g)].map((m) => m[1]))];
  const native = used.filter((n) => !Object.getOwnPropertyDescriptor(window, 'ARENA_' + n));
  // the names the page itself writes as ARENA_* (add-ons, prices ...) need no alias; every other one does
  for (const n of native) assert.match(PAGE + readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8'), new RegExp(`window\\.ARENA_${n}\\b`), `the bridge uses ARENA_${n}, which the page neither aliases nor sets`);
  window.ARENA_UNITY_LOBBY = { showing: true };
  assert.deepEqual(window.BLWP_UNITY_LOBBY, { showing: true }, 'what Unity writes the page reads');
  window.BLWP_ROUND = 'r';
  assert.equal(window.ARENA_ROUND, 'r', 'what the page writes Unity reads');
});
