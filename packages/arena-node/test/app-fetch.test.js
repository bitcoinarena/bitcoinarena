// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS ARE DOWNLOADED AT THEIR PINS (kanban #575): a release without the apps gets each from its repository at the commit
// apps.lock.json names, every file checked against apps.files.json before it is placed; a wrong byte places nothing; the cache makes an
// update with the same pin download nothing; a folder the release carries itself is left alone; a moved pin is fetched again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureApps, appPins, rawUrl } from '../src/app-fetch.js';
import { appsFiles } from '../../../tools/pin-apps.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8'));

// GitHub as the copies have it: raw.githubusercontent.com/<repo>/<commit>/<path> -> <copy>/<path>, the pinned commit only
function github({ tamper = null, missing = null } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    for (const app of Object.values(lock.apps)) {
      const base = `https://raw.githubusercontent.com/${app.repo}/${app.commit}/`;
      if (!url.startsWith(base)) continue;
      const path = url.slice(base.length).split('/').map(decodeURIComponent).join('/');
      if (path === missing) return new Response('', { status: 404 });
      let b; try { b = readFileSync(join(ROOT, app.copy, path)); } catch { return new Response('', { status: 404 }); }
      if (path === tamper) b = Buffer.concat([b, Buffer.from('\n// one more line')]);
      return new Response(b, { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, calls };
}
function release() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-575-release-'));
  for (const f of ['apps.lock.json', 'apps.files.json']) cpSync(join(ROOT, f), join(dir, f));
  return dir;
}
const home = () => mkdtempSync(join(tmpdir(), 'arena-575-home-'));

test('apps.files.json is what tools/pin-apps.mjs makes of the copies: run it again when a pin moves', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'apps.files.json'), 'utf8')), appsFiles(ROOT));
  const pins = appPins(ROOT);
  assert.deepEqual(pins.map((a) => a.name).sort(), ['arena-app-next-block', 'arena-app-rock-paper-scissors', 'arena-app-up-or-down'], 'the three apps a node hosts');
  for (const a of pins) {
    assert.ok(a.files['app.json'], `${a.name} carries its app.json`);
    assert.ok(!Object.keys(a.files).some((p) => p.startsWith('test/') || p.startsWith('unity/')), `${a.name}: no tests, no Unity project`);
  }
});

test('a release without its apps gets all three from GitHub at the pins, byte for byte, executables kept executable', async () => {
  const r = release(), h = home(), g = github();
  const out = await ensureApps({ release: r, home: h, fetcher: g.fetcher });
  assert.deepEqual(out, { ok: true, fetched: ['arena-app-next-block', 'arena-app-rock-paper-scissors', 'arena-app-up-or-down'], kept: [] });
  for (const a of appPins(r)) {
    for (const p of Object.keys(a.files)) assert.ok(readFileSync(join(r, a.copy, p)).equals(readFileSync(join(ROOT, a.copy, p))), `${a.copy}/${p}`);
    assert.deepEqual(JSON.parse(readFileSync(join(r, a.copy, '.arena-app.json'), 'utf8')), { repo: a.repo, commit: a.commit, files: Object.keys(a.files).length });
    for (const p of a.exec) assert.ok(statSync(join(r, a.copy, p)).mode & 0o100, `${p} is executable`);
  }
  assert.equal(g.calls.length, appPins(r).reduce((n, a) => n + Object.keys(a.files).length, 0), 'one request a file');
  assert.ok(g.calls.every((u) => u.startsWith('https://raw.githubusercontent.com/bitcoin-arena/arena-app-')), 'only the apps\' own repositories');
  // the same release again: nothing to do; a new release beside it with the same pins: from the cache, no request
  assert.deepEqual(await ensureApps({ release: r, home: h, fetcher: g.fetcher }), { ok: true, fetched: [], kept: ['arena-app-next-block', 'arena-app-rock-paper-scissors', 'arena-app-up-or-down'] });
  const r2 = release(), before = g.calls.length;
  assert.equal((await ensureApps({ release: r2, home: h, fetcher: g.fetcher })).fetched.length, 3);
  assert.equal(g.calls.length, before, 'an update with the same pins downloads nothing');
});

test('one wrong byte places nothing of that app; a file GitHub does not have stops it too', async () => {
  const r = release(), g = github({ tamper: 'plugin/rock-paper-scissors.js' });
  const out = await ensureApps({ release: r, home: home(), fetcher: g.fetcher });
  assert.equal(out.ok, false);
  assert.match(out.why, /plugin\/rock-paper-scissors\.js has SHA-256 [0-9a-f]{16}\.\.\., not the pinned [0-9a-f]{16}\.\.\.: refused \(from github.com\/bitcoin-arena\/arena-app-rock-paper-scissors\)/);
  assert.ok(!existsSync(join(r, 'packages/rock-paper-scissors')) && !existsSync(join(r, 'packages/rock-paper-scissors.fetching')), 'nothing placed');
  const m = await ensureApps({ release: release(), home: home(), fetcher: github({ missing: 'app.json' }).fetcher });
  assert.equal(m.ok, false);
  assert.match(m.why, /app\.json answered 404/);
});

test('a folder the release carries itself is left alone; a pin that moved is fetched again', async () => {
  const r = release(), h = home(), g = github();
  mkdirSync(join(r, 'packages/nextblock'), { recursive: true });
  writeFileSync(join(r, 'packages/nextblock/own.txt'), 'bundled');
  const out = await ensureApps({ release: r, home: h, fetcher: g.fetcher });
  assert.deepEqual(out.kept, ['arena-app-next-block']);
  assert.equal(readFileSync(join(r, 'packages/nextblock/own.txt'), 'utf8'), 'bundled');
  // the release's pin for Up or Down moves: its folder, placed for the old pin, is replaced
  const marker = join(r, 'packages/btc-updown/.arena-app.json');
  writeFileSync(marker, JSON.stringify({ repo: 'bitcoin-arena/arena-app-up-or-down', commit: '0'.repeat(40), files: 1 }));
  writeFileSync(join(r, 'packages/btc-updown/stale.js'), 'old');
  assert.deepEqual((await ensureApps({ release: r, home: h, fetcher: g.fetcher })).fetched, ['arena-app-up-or-down']);
  assert.ok(!existsSync(join(r, 'packages/btc-updown/stale.js')), 'the old pin\'s files are gone');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).commit, lock.apps['arena-app-up-or-down'].commit);
});

test('a release from before #575 (no apps.files.json) fetches nothing; a manifest path outside the app is refused', async () => {
  const old = mkdtempSync(join(tmpdir(), 'arena-575-old-'));
  assert.deepEqual(await ensureApps({ release: old, home: home(), fetcher: async () => { throw new Error('no request'); } }), { ok: true, fetched: [], kept: [] });
  const r = release();
  const files = JSON.parse(readFileSync(join(r, 'apps.files.json'), 'utf8'));
  files.apps['arena-app-up-or-down'].files['../../escape.js'] = 'a'.repeat(64);
  writeFileSync(join(r, 'apps.files.json'), JSON.stringify(files));
  const out = await ensureApps({ release: r, home: home(), fetcher: github().fetcher });
  assert.equal(out.ok, false);
  assert.match(out.why, /the manifest names "\.\.\/\.\.\/escape\.js", not a file of the app/);
  assert.equal(rawUrl('a/b', 'c', 'x y/z#.js'), 'https://raw.githubusercontent.com/a/b/c/x%20y/z%23.js');
});
