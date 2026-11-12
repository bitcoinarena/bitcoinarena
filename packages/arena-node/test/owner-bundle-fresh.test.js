// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S BUNDLE IS WHAT ITS SOURCE BUILDS (kanban #2251, #2262): pages/owner-client.js is the page's copy of
// plugin-check.js and the rest of pages/owner-entry.js. #1854 changed plugin-check.js and the committed bundle was not
// rebuilt, so the owner's tab still verified every ancestor of a peer's package. tools/bundle-owner.mjs --check fails
// when the committed bundle is not what the source builds. Skipped only where esbuild is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../tools/bundle-owner.mjs', import.meta.url));
const esbuild = fileURLToPath(new URL('../../arena-client/node_modules/esbuild/lib/main.js', import.meta.url));

test('pages/owner-client.js is what pages/owner-entry.js builds (bundle-owner.mjs --check)', { skip: !existsSync(esbuild) && 'esbuild is not installed here' }, () => {
  const r = spawnSync(process.execPath, [tool, '--check'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.trim());
});
