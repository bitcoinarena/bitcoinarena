// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA BUILDS ITS OWN PAGE (kanban #569, 2026-10-21: "The Arena keeps only its own page"; it was Unity's WebGL template, kept a
// copy of src/arena-ui by tools/sync-arena-ui.mjs): the page is src/arena-ui and each app's page parts, Next Block's Unity project holds
// no copy of it, and the page is filled with the app's pinned client - its names, versions, sizes and every file's hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { sources, fill, pagePins, CLIENT_PATHS } from '../../../tools/build-arena-page.mjs';

const ROOT = new URL('../../../', import.meta.url);
const pin = { app: 'nextblock', title: 'Tick Tock, Next Block', release: 'webgl-9-DXT', build: 'webgl-9-DXT', productVersion: '0.0.9',
  files: { 'Build/webgl-9-DXT.loader.js': { sha256: 'aa'.repeat(32) }, 'Build/webgl-9-DXT.wasm.unityweb': { sha256: 'bb'.repeat(32), unpackedSha256: 'cc'.repeat(32) } } };

test('the page is src/arena-ui and the apps\' page parts; Next Block\'s Unity project carries no copy of it', () => {
  const s = sources();
  assert.ok(s['index.html'].endsWith('src/arena-ui/index.html'));
  assert.ok(s['games/nextblock/unity-page.js'].endsWith('packages/nextblock/page/unity-page.js'));
  assert.ok(s['games/btc-updown/market-page.js'].endsWith('packages/btc-updown/page/market-page.js'));
  assert.ok(!Object.keys(s).some((k) => CLIENT_PATHS.some((p) => k === p || k.startsWith(p + '/'))), 'no client file comes from the Arena\'s source');
  // THE UNITY PROJECT IS THE APP'S REPOSITORY'S (2026-10-21: "Do not leave the Unity project in bitcoin-arena")
  assert.equal(existsSync(new URL('unity-proto', ROOT)), false, 'no unity-proto');
  assert.equal(existsSync(new URL('packages/nextblock/unity', ROOT)), false, 'no copy of it in packages/nextblock');
  const lock = JSON.parse(readFileSync(new URL('apps.lock.json', ROOT), 'utf8'));
  assert.equal(lock.apps['arena-app-next-block'].repo, 'bitcoin-arena/arena-app-next-block', 'the Arena reads it from the app at a pinned commit');
  assert.match(lock.apps['arena-app-next-block'].commit, /^[0-9a-f]{40}$/);
});

test('the page is filled with the pinned client: its file names, product and UI version, sizes and pins (unpacked for a .unityweb)', () => {
  assert.deepEqual(pagePins(pin), { 'Build/webgl-9-DXT.loader.js': 'aa'.repeat(32), 'Build/webgl-9-DXT.wasm.unityweb': 'cc'.repeat(32) });
  const html = readFileSync(new URL('src/arena-ui/index.html', ROOT), 'utf8');
  const out = fill(html, { pin, ui: 282, sizes: { 'webgl-9-DXT.wasm.unityweb': [10, 30] } });
  assert.doesNotMatch(out, /\{\{\{|'__APP_BUILD_PINS__'|'__BUILD_SIZES__'/);
  assert.match(out, /window\.ARENA_UNITY_LOADER = 'Build\/webgl-9-DXT\.loader\.js';/);
  assert.match(out, /codeUrl: 'Build\/webgl-9-DXT\.wasm\.unityweb'/);
  assert.match(out, /build 0\.0\.9 · UI 282/);
  assert.ok(out.includes(JSON.stringify(JSON.stringify(pagePins(pin)))), 'the pins inside the page');
  assert.throws(() => fill(html.replace("'__APP_BUILD_PINS__'", "''"), { pin, ui: 1, sizes: {} }), /no '__APP_BUILD_PINS__'/);
});

test('the page checks every client file it fetches against the pins, and starts no client without them', () => {
  const html = readFileSync(new URL('src/arena-ui/index.html', ROOT), 'utf8');
  assert.match(html, /const APP_PINS = \(\(\) => \{ try \{ return JSON\.parse\('__APP_BUILD_PINS__'\); \} catch \{ return null; \} \}\)\(\);/);
  assert.match(html, /if \(!APP_PINS\) return \{ rel, why: 'this page was built without its client\\'s pins' \};/);
  assert.match(html, /try \{ await checkPinned\(pin, all\); \} catch \(e\) \{ console\.error\('\[arena\] ' \+ e\.message\); c\.error\(e\); return; \}/);
  assert.match(readFileSync(new URL('packages/nextblock/page/unity-page.js', ROOT), 'utf8'), /window\.ARENA_PINNED_SCRIPT\(window\.ARENA_UNITY_LOADER\)/);
});
