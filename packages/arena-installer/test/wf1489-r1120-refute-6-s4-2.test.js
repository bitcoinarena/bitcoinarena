// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3128 (refute of #3068/#3114), the other door: the wizard's first bond (wizard.js passes its OWN release, which may be older than
// the node's) in the window between STARTED and KEPT of an update. Neither s.release.path nor the wizard's release names the running one;
// the open update journal does: its units run `to` once written, `from` before that and while rolling back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { bondGamesOf, hostedGameIdsOf } from '../src/apps.js';
import { UPDATE_PHASE as U, journalFile } from '../src/update.js';

function olderRelease(repo) {
  const rel = mkdtempSync(join(tmpdir(), 'r1120-6-s4-2-old-'));
  for (const [app, title, files] of [['nextblock', 'Tick Tock, Next Block', ['nextblock.js', 'nextblock-v2.js']], ['rock-paper-scissors', 'Rock Paper Scissors', ['rock-paper-scissors.js']]]) {
    const dir = join(rel, 'packages', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ id: app, title, registrations: files.map((f) => relative(dir, join(repo, 'packages', app, 'plugin', f))) }));
  }
  return rel;
}

test('#3128: an open update journal names the release a first bond reads, whatever door builds it', async () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const apps = ['nextblock', 'rock-paper-scissors'];
  const oldRel = olderRelease(repo);
  const want = (await hostedGameIdsOf(repo, apps)).sort();
  const old = (await hostedGameIdsOf(oldRel, apps)).sort();
  assert.ok(old.length > 0 && old.length < want.length, 'fixture: the old release hosts fewer games');
  const s = { apps, hostedGames: old, bond: null, release: { path: oldRel, atMs: 1 } };
  const home = mkdtempSync(join(tmpdir(), 'r1120-6-s4-2-'));
  const journal = (phase) => writeFileSync(journalFile(home), JSON.stringify({ id: 'u1', phase, from: oldRel, to: repo }));
  // no journal: the record (the wizard's door, as #3114 made it)
  assert.deepEqual((await bondGamesOf(s, oldRel, { home })).sort(), old);
  for (const phase of [U.UNITS_WRITTEN, U.STARTED]) {
    journal(phase);
    assert.deepEqual((await bondGamesOf(s, oldRel, { home })).sort(), want, `${phase}: the new release's units run`);
  }
  for (const phase of [U.STOPPING, U.BACKED_UP, U.ROLLING_BACK]) {
    journal(phase);
    assert.deepEqual((await bondGamesOf({ ...s, release: { path: repo } }, repo, { home, runs: repo })).sort(), old, `${phase}: the old release runs`);
  }
  journal(U.KEPT);
  assert.deepEqual((await bondGamesOf(s, oldRel, { home, runs: repo })).sort(), want, 'a closed journal: the running code the door names');
});
