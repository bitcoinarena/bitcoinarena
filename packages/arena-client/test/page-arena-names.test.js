// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE KEEPS EVERY VALUE UNDER ARENA'S NAMES (kanban #522, #523, #524): ARENA_JOIN, ARENA_ROUND, ARENACLIENT ... The old names are
// left only for what is already out - Rock Paper Scissors 1-3's pinned clients read window.parent.BLWP_JOIN, BLWP_JOIN_ANSWER and
// BLWP_ROW_NODES, and Unity build 524 calls BLWPCLIENT and BLWP_CURVE - and each reads and writes its ARENA_ value, live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const ALIASES = "    [['BLWP_JOIN', 'ARENA_JOIN'], ";
const aliased = () => {
  const at = PAGE.indexOf(ALIASES);
  assert.ok(at > 0, 'the page names no old-name aliases');
  const window = {};
  new Function('window', PAGE.slice(at, PAGE.indexOf('    });\n', at) + 8))(window);
  return window;
};

test('BLWP_JOIN, BLWP_JOIN_ANSWER and BLWP_ROW_NODES read and write the ARENA_ values live (RPS 1-3)', () => {
  const window = aliased();
  const nodes = () => ['a'];
  Object.assign(window, { ARENA_JOIN: { state: 'joining' }, ARENA_JOIN_ANSWER: { ok: true }, ARENA_ROW_NODES: nodes });
  assert.deepEqual(window.BLWP_JOIN, { state: 'joining' });
  assert.deepEqual(window.BLWP_JOIN_ANSWER, { ok: true });
  assert.equal(window.BLWP_ROW_NODES, nodes);
  window.ARENA_JOIN = { state: 'joined' };
  assert.equal(window.BLWP_JOIN.state, 'joined', 'read live, not copied once');
  window.BLWP_JOIN = { state: 'refused' };
  assert.equal(window.ARENA_JOIN.state, 'refused', 'an old writer reaches the ARENA_ value');
});

test('BLWPCLIENT and BLWP_CURVE are ARENACLIENT and ARENA_CURVE, set after the aliases (Unity build 524)', () => {
  const window = aliased();
  const client = { roundId() {} }, curve = { verify() {} };
  window.ARENACLIENT = client; window.ARENA_CURVE = curve;   // the bundles load after the alias block
  assert.equal(window.BLWPCLIENT, client);
  assert.equal(window.BLWP_CURVE, curve);
});

test('every ARENA_ name Unity\'s bridge reads or writes is one the page or the bridge sets (kanban #524)', () => {
  const jslib = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  const unityPage = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');
  const used = [...new Set([...jslib.matchAll(/\bARENA_([A-Z][A-Z_]*)\b/g)].map((m) => m[1]))];
  for (const n of used) {
    const set = new RegExp(`window\\.ARENA_${n}\\b`).test(PAGE + unityPage) || new RegExp(`window\\.ARENA_${n}\\s*=`).test(jslib);
    assert.ok(set, `the bridge uses ARENA_${n}, which neither the page nor the bridge sets`);
  }
});

test('the page keeps no value under a BLWP_ name: the alias block is the only place they appear', () => {
  // from the block's own comment to its end
  const at = PAGE.indexOf('    // THE OLD NAMES, READ ONLY BY WHAT IS ALREADY OUT'), end = PAGE.indexOf('    });\n', PAGE.indexOf(ALIASES)) + 8;
  assert.ok(at > 0);
  const rest = PAGE.slice(0, at) + PAGE.slice(end);
  assert.deepEqual([...rest.matchAll(/\bBLWP_[A-Z][A-Z_]*\b|\bBLWPCLIENT\b/g)].map((m) => m[0]), []);
});
