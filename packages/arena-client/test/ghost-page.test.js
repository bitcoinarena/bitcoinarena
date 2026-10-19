// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S GHOSTS ARE ITS OWN PAGE SCRIPT (§0A.2, kanban #525): packages/nextblock/page/ghost-page.js is the build of
// ghost-field.js, the page loads it after the engine's bundle and before Tick Tock's bridge, and it puts on BLWPCLIENT the same
// functions Unity's jslib calls - the same results as the module's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ghostPage } from '../../nextblock/tools/bundle-ghost-page.mjs';
import * as field from '../../nextblock/page/ghost-field.js';

const PAGE_JS = new URL('../../nextblock/page/ghost-page.js', import.meta.url);

test('ghost-page.js is the build of ghost-field.js', () => {
  assert.equal(readFileSync(PAGE_JS, 'utf8'), ghostPage(), 'run packages/nextblock/tools/bundle-ghost-page.mjs');
});

test('loaded after the bundle, it puts the jslib\'s functions on BLWPCLIENT, and they answer as the module does', () => {
  const BLWPCLIENT = createRequire(import.meta.url)('../dist/arena-client.js');
  assert.equal(typeof BLWPCLIENT.watchGhosts, 'undefined', 'the engine bundle carries no ghost code');
  const window = { BLWPCLIENT: { ...BLWPCLIENT } };
  new Function('window', readFileSync(PAGE_JS, 'utf8'))(window);
  const jslib = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  for (const name of ['watchGhosts', 'tickClock', 'ghostLabels', 'ghostLabelText', 'newestPose']) {
    assert.ok(jslib.includes('BLWPCLIENT.' + name), `the jslib no longer calls ${name}`);
    assert.equal(typeof window.BLWPCLIENT[name], 'function', name);
  }
  const g = { playerPubkey: new Uint8Array(32).fill(7), tick: 5 };
  assert.equal(window.BLWPCLIENT.playersLine({ joined: true, others: 2 }), field.playersLine({ joined: true, others: 2 }));
  assert.deepEqual(window.BLWPCLIENT.ghostLabels(new Map([['aa', g]]), { nowMs: 1 }), field.ghostLabels(new Map([['aa', g]]), { nowMs: 1 }));
});

test('the page loads it after the bundle and before Tick Tock\'s bridge', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const bundle = html.indexOf('<script src="arena-client.js"></script>'), ghosts = html.indexOf('<script src="games/nextblock/ghost-page.js"></script>');
  const bridge = html.indexOf('<script src="games/nextblock/unity-page.js"></script>');
  assert.ok(bundle > 0 && ghosts > bundle && bridge > ghosts, `order: bundle ${bundle}, ghosts ${ghosts}, bridge ${bridge}`);
});
