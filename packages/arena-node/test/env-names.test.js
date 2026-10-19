// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ENVIRONMENT SPEAKS ARENA_* (kanban #522): no package reads a BLWP_* variable from process.env, and every script or patch that
// still reads an old BLWP_* name reads its ARENA_* name first - the old one only as the fallback that keeps an un-updated setup
// starting. Measured 2026-10-19: the node and the live seat tree read 68 ARENA_* names and no BLWP_* one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !/^(TASKBOOK|PRIORITIES)\.md$|^docs\/|^archive\/|^monitoring\/|^deploy\/daily\//.test(f));   // history; the retired phase0 Daily
const read = (f) => { try { return readFileSync(`${ROOT}/${f}`, 'utf8'); } catch { return ''; } };

test('no package reads a BLWP_* variable from process.env', () => {
  const bad = [];
  for (const f of files.filter((x) => /^packages\/[^/]+\/(src|bin|tools)\/.*\.(m?js|cjs)$/.test(x))) {
    for (const m of read(f).matchAll(/process\.env(?:\.|\[\s*['"`])(BLWP_[A-Z0-9_]+)/g)) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('a script or patch reading an old BLWP_* name reads its ARENA_* name first', () => {
  const bad = [];
  for (const f of files.filter((x) => /\.(sh|patch)$/.test(x))) {
    const s = read(f);
    for (const m of s.matchAll(/\$\{?(BLWP_[A-Z0-9_]+)|std::env::var\("(BLWP_[A-Z0-9_]+)"\)/g)) {
      const old = m[1] || m[2]; const now = 'ARENA_' + old.slice(5);
      if (!s.includes(now)) bad.push(`${f}: ${old} without ${now}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the fallback reads the ARENA_* name and, without it, the old BLWP_* one', () => {
  const line = /ASTC_DIR="\$\{ARENA_ASTC_BUILD_DIR:-\$\{BLWP_ASTC_BUILD_DIR:-\}\}"/.exec(read('deploy-core.sh'));
  assert.ok(line, 'deploy-core.sh reads ARENA_ASTC_BUILD_DIR, then BLWP_ASTC_BUILD_DIR');
  const run = (env) => execFileSync('bash', ['-c', `${line[0]}; printf %s "$ASTC_DIR"`], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run({ ARENA_ASTC_BUILD_DIR: '/new', BLWP_ASTC_BUILD_DIR: '/old' }), '/new');
  assert.equal(run({ BLWP_ASTC_BUILD_DIR: '/old' }), '/old', 'an un-updated setup still works');
  assert.equal(run({}), '');
  const r = /ARENA_BITCOIND_URL=\$\{ARENA_BITCOIND_URL:-\$BLWP_BITCOIND_URL\}/.exec(read('packages/arena-node/tools/rehearse209b-after.sh'));
  assert.ok(r, 'rehearse209b-after.sh: ARENA_BITCOIND_URL, then BLWP_BITCOIND_URL');
  const url = (env) => execFileSync('bash', ['-c', `${r[0]}; printf %s "$ARENA_BITCOIND_URL"`], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(url({ ARENA_BITCOIND_URL: 'http://new' }), 'http://new');
  assert.equal(url({ BLWP_BITCOIND_URL: 'http://old' }), 'http://old');
});
