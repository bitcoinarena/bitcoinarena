// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN AGENT RUNS AS AN APP RUNS (kanban #1122, measured 2026-11-04 on the main test host): an agent with no ProcessType ran at priority 20
// (spawn type daemon), a program started from a shell at 31; on a busy machine the installer node's loop was held up to 16 s while its thread
// used under 1 s of processor, and its GET /identity went unanswered for 5-15 s. Every agent the installer writes says Interactive, and
// an update moves an older agent to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchdPlist, installProgram, interactivePlist, LAUNCHD_LABEL } from '../src/service.js';

const INTERACTIVE = /<key>ProcessType<\/key><string>Interactive<\/string>/;
const lint = (file) => { if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file]); };

test('the seat\'s agent and every program\'s agent say ProcessType Interactive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-1122-'));
  try {
    assert.match(launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 }), INTERACTIVE);
    const calls = [];
    const r = await installProgram({ id: 'gateway', description: 'the gateway', args: ['/bin/true'], home: root, env: { HOME: root }, platform: 'darwin',
      sh: async (...a) => { calls.push(a); return { ok: true, out: '', err: '' }; } });
    assert.equal(r.ok, true);
    const file = join(root, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.gateway.plist`);
    assert.match(readFileSync(file, 'utf8'), INTERACTIVE);
    lint(file);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an older agent with no ProcessType is moved to Interactive once; one that names its own keeps it', () => {
  const now = launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 });
  const older = now.replace(/\n\s*<key>ProcessType<\/key><string>Interactive<\/string>/, '');
  assert.doesNotMatch(older, /ProcessType/);
  const moved = interactivePlist(older);
  assert.match(moved, INTERACTIVE);
  assert.match(moved, /<\/dict>\n<\/plist>\n$/);
  assert.equal(interactivePlist(moved), moved, 'a second move changes nothing');
  const own = older.replace('</dict>', '  <key>ProcessType</key><string>Background</string>\n</dict>');
  assert.equal(interactivePlist(own), own);
  assert.equal(interactivePlist('[Unit]\nDescription=x\n'), '[Unit]\nDescription=x\n', 'not a plist: unchanged');
});
