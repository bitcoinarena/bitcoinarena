// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE CARRIES TWO CORES AND THE ROUND SAYS WHICH (2026-10-04, path A): 2069b4c2 for every round published
// before C became the bed fill and T sank from 20 s, the current core for every round after. The page's own script, run
// over its two bundles: the round's hash picks the core under Unity's state and the global the jslib's init reads, and a
// hash the page carries no core for is refused. The bundles are the ones the cores hash to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';

const T = new URL('../../../src/arena-ui/', import.meta.url);
const html = readFileSync(new URL('index.html', T), 'utf8');
const OLD = '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e';
const DE2F = 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8';
// 7e2123d1, the core before 68e2b3d6: §4.11's objectives from the relief; kept beside it for its rounds
const S7E = '7e2123d1990d1443fcac12dc6c7575059935d89d794822bc69c67b184870ce20';
const NEW = coreHashHex();
const FROZEN = new URL('../../nextblock/frozen/2069b4c2', import.meta.url).pathname;

function page() {
  const window = { console: { log() {} } };
  window.window = window;
  const ctx = vm.createContext(window);
  const scripts = [...html.matchAll(/<script( src="(blwp-core[^"]*)")?>([\s\S]*?)<\/script>/g)];
  const cut = scripts.findIndex((m) => m[2] === 'blwp-core-2069b4c2.js');
  for (const m of scripts.slice(cut, cut + 8)) {
    const code = m[2] ? readFileSync(new URL(m[2], T), 'utf8') : m[3];
    vm.runInContext(code + (m[2] ? '\nwindow.BLWP = BLWP;' : ''), ctx);
  }
  return window;
}

test('the page names the current core as its default, and both bundles are the cores their hashes name', () => {
  assert.ok(html.includes(`window.ARENA_CORE_DEFAULT = '${NEW}'`), `the page's default is not the core this tree hashes to (${NEW.slice(0, 16)})`);
  assert.equal(coreHashHex(FROZEN), OLD, 'core/frozen/2069b4c2 is not 2069b4c2');
  assert.equal(readFileSync(new URL('blwp-core.js', T), 'utf8'), readFileSync(new URL('../../nextblock/dist/blwp-core.js', import.meta.url), 'utf8'),
    'the page carries a stale current core');
  assert.equal(readFileSync(new URL('blwp-core-2069b4c2.js', T), 'utf8'), readFileSync(new URL('../../nextblock/dist/blwp-core-2069b4c2.js', import.meta.url), 'utf8'),
    'the page carries another 2069b4c2 bundle than the one built from its frozen source');
});

test('the round\'s hash picks its core: under Unity\'s state and as the global the jslib reads; an unknown one is refused', () => {
  const w = page();
  const cores = w.ARENA_CORES;
  assert.deepEqual(Object.keys(cores).sort(), [OLD, DE2F, S7E, NEW].sort());
  assert.equal(readFileSync(new URL('blwp-core-7e2123d1.js', T), 'utf8'), readFileSync(new URL('../../nextblock/dist/blwp-core-7e2123d1.js', import.meta.url), 'utf8'),
    'the page carries another 7e2123d1 bundle');
  assert.equal(coreHashHex(new URL('../../nextblock/frozen/7e2123d1', import.meta.url).pathname), S7E, 'core/frozen/7e2123d1 is not 7e2123d1');
  assert.notEqual(cores[S7E], cores[NEW]);
  assert.equal(readFileSync(new URL('blwp-core-de2f263d.js', T), 'utf8'), readFileSync(new URL('../../nextblock/dist/blwp-core-de2f263d.js', import.meta.url), 'utf8'),
    'the page carries another de2f263d bundle');
  assert.notEqual(cores[OLD], cores[NEW]);
  // the two really differ where the rule moved: an empty bed is 0 on the new core, 0.7 on 2069b4c2
  const fresh = (c) => c.init(7);
  assert.ok(typeof cores[NEW].bedFill === 'function' && typeof cores[OLD].bedFill !== 'function', 'the new core has the bed fill, the old does not');
  assert.equal(cores[NEW].cargoOf(fresh(cores[NEW])), 0);
  w.unityInstance = { Module: { blwp: { core: cores[NEW], st: fresh(cores[NEW]) } } };
  const hexBytes = Uint8Array.from(Buffer.from(OLD, 'hex'));
  assert.equal(w.ARENA_USE_CORE(hexBytes).ok, true);
  assert.equal(w.unityInstance.Module.blwp.core, cores[OLD], 'Unity still runs the current core for a 2069b4c2 round');
  assert.equal(w.BLWP, cores[OLD], 'the jslib\'s BlwpInit would make the round\'s world on the current core');
  assert.equal(w.ARENA_USE_CORE(NEW).ok, true);
  assert.equal(w.unityInstance.Module.blwp.core, cores[NEW]);
  const no = w.ARENA_USE_CORE('ab'.repeat(32));
  assert.equal(no.ok, false);
  assert.match(no.why, /carries no such core/);
  assert.equal(w.unityInstance.Module.blwp.core, cores[NEW], 'a refused hash moved the core');
});

test('the join takes the round\'s core before anything of the round is made, and refuses a core it does not carry', () => {
  const a = html.indexOf('      window.BLWP_ROUND = named.round;\n');
  const b = html.indexOf('window.ARENA_USE_CORE(BLWPCLIENT.roundCoreHex(named.round))', a);
  assert.ok(a > 0 && b > a && b - a < 800, 'the join does not hand the round\'s core hash to ARENA_USE_CORE right after naming the round');
  assert.ok(html.slice(b, b + 500).includes("window.BLWP_JOIN_REFUSED = core.why"), 'an unknown core is not refused by name');
});
