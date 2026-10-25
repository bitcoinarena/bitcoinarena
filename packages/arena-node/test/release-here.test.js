// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE ON BOTH DASHBOARDS (kanban #674: "include version in node dashboard and owner dashboard"): /dashboard.json and /setup-status
// carry the release this node runs, as /owner/version does - the same VERSION and COMMIT files (null for both from a checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { joinedWithLock } from './lock-fixture.js';

test('the release this node runs, on /dashboard.json, /setup-status and /owner/version alike', async () => {
  const home = mkdtempSync(join(tmpdir(), 'release-here-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4' }));
  const was = process.env.ARENA_HOME;
  process.env.ARENA_HOME = home;
  const s = await joinedWithLock({ owner: { store: { read: () => null, write: () => {}, writeCode: () => {} } } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const v = await (await fetch(`${base}/owner/version`)).json();
    const d = await (await fetch(`${base}/dashboard.json`)).json();
    const st = await (await fetch(`${base}/setup-status`)).json();
    assert.deepEqual(d.release, { version: v.version, commit: v.commit });
    assert.deepEqual(st.release, { version: v.version, commit: v.commit });
    assert.ok('node' in d && 'roundsChecked' in d, 'the dashboard\'s own fields are still there');
  } finally {
    if (was === undefined) delete process.env.ARENA_HOME; else process.env.ARENA_HOME = was;
    await s.d.close(); rmSync(home, { recursive: true, force: true });
  }
});
