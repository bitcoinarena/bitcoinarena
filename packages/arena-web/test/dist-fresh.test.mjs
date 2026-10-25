// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BUNDLES A RELEASE SHIPS ARE THE BUILD OF THIS SOURCE (kanban #564, 2026-10-21: "pack the release"): every page script
// packages/arena-web builds - the node's owner screens, dashboard, rounds and "my node is offline" pages, the installer's steps, the Arena
// page's one bundle, its health and proposals views - is built again here with esbuild into a folder of its own (tools/build.mjs,
// ARENA_WEB_OUT) and must be byte for byte what dist/ and the pages' own copies hold. A view changed without its build fails here, not
// on a node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '../..');
const read = (p) => readFileSync(p);

test('every bundle in dist/ and every copy beside its page is the build of this source', () => {
  const out = mkdtempSync(join(tmpdir(), 'arena-web-fresh-'));
  try {
    execFileSync(process.execPath, [join(root, 'tools/build.mjs')], { cwd: root, env: { ...process.env, ARENA_WEB_OUT: out }, stdio: 'pipe' });
    const built = readdirSync(out).sort();
    for (const f of ['arena.css', 'arena.js', 'dashboard.js', 'emergency.js', 'health.js', 'owner.js', 'proposals.js', 'rounds.js', 'wizard.js'])
      assert.ok(built.includes(f), `the build makes ${f}`);
    const stale = [];
    const same = (shipped, f) => { if (!read(shipped).equals(read(join(out, f)))) stale.push(`${shipped.slice(repo.length + 1)} (${f})`); };
    // what the node and its release read from dist/ (tracked there)
    for (const f of ['arena.css', 'dashboard.js', 'emergency.js', 'health.js', 'owner.js', 'proposals.js', 'rounds.js']) same(join(root, 'dist', f), f);
    // the copies each page carries beside itself
    same(join(repo, 'src/arena-ui/arena-react.js'), 'arena.js');
    same(join(repo, 'src/arena-ui/health/react.js'), 'health.js');
    same(join(repo, 'src/arena-ui/proposals/react.js'), 'proposals.js');
    same(join(repo, 'src/arena-ui/offline/react.js'), 'emergency.js');
    same(join(repo, 'packages/arena-installer/www/wizard.js'), 'wizard.js');
    assert.deepEqual(stale, [], 'not rebuilt: run node packages/arena-web/tools/build.mjs ');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
