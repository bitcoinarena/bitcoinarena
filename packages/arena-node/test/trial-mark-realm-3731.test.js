// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3731: the kept trial mark (#3679) names every file that decides the trial's verdict - the trial, the check and the whole core
// realm, every core-*.js of src (so a realm file added later counts without being listed) and the acorn core-depth parses with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRIAL_CODE_FILES } from '../src/plugin-package.js';

test('#3731 the trial mark key reads the whole sandbox realm, not only the trial', () => {
  assert.ok(Array.isArray(TRIAL_CODE_FILES), 'the trial code list is read');
  const src = readdirSync(fileURLToPath(new URL('../src/', import.meta.url)));
  const realm = src.filter((f) => f.startsWith('core-') && f.endsWith('.js'));
  for (const f of ['core-host.js', 'core-driver.js', 'core-depth.js', 'core-intrinsics.js', 'core-sandbox.js', 'core-compile-apart.js',
    'core-compile-child.js', 'core-supervisor.js', 'core-runner.js']) assert.ok(realm.includes(f), `${f} is still in src`);
  for (const f of [...realm, 'plugin-trial.js', 'plugin-check.js', 'vendor/acorn.mjs']) assert.ok(TRIAL_CODE_FILES.includes(f), `the mark key reads ${f}`);
});
