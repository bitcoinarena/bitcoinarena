// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE'S TWO PIN FILES NAME THE SAME COMMIT OF EVERY APP (kanban #806, the owner 2026-10-30 playtest of the install script: "The apps could
// not be downloaded: the release's app pins do not read: arena-app-next-block: apps.files.json is for 5c19be53e780, apps.lock.json pins
// 2d75dadb233d"). 7eb39c1b / deb1872c moved Next Block in apps.lock.json and apps.files.json was not made again (tools/pin-apps.mjs), so
// v2026.1.9.18 refused every fresh install at the apps. app-fetch.test checks the files against the apps' own checkouts, which a release
// check without them never ran; this reads the two files alone - what a node reads on its first start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appPins } from '../src/app-fetch.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));

test('every app apps.files.json lists is pinned at the same commit in apps.lock.json, as a node reads them (appPins)', () => {
  const lock = read('apps.lock.json'), files = read('apps.files.json');
  for (const [name, f] of Object.entries(files.apps)) {
    assert.ok(lock.apps[name], `${name}: in apps.files.json, not in apps.lock.json`);
    assert.equal(f.commit, lock.apps[name].commit, `${name}: apps.files.json is for ${f.commit.slice(0, 12)}, apps.lock.json pins ${lock.apps[name].commit.slice(0, 12)} - run node tools/fetch-apps.mjs && node tools/pin-apps.mjs`);
    assert.ok(Object.keys(f.files).length > 0, `${name}: no files listed`);
  }
  assert.doesNotThrow(() => appPins(ROOT), 'the pins read as a node reads them on its first start');
});

test('the failure as the installer met it: a lock moved without apps.files.json is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-806-'));
  const lock = read('apps.lock.json'), files = read('apps.files.json');
  writeFileSync(join(dir, 'apps.files.json'), JSON.stringify(files));
  writeFileSync(join(dir, 'apps.lock.json'), JSON.stringify({ ...lock, apps: { ...lock.apps, 'arena-app-next-block': { ...lock.apps['arena-app-next-block'], commit: 'f'.repeat(40) } } }));
  assert.throws(() => appPins(dir), /arena-app-next-block: apps\.files\.json is for [0-9a-f]{12}, apps\.lock\.json pins ffffffffffff/);
});
