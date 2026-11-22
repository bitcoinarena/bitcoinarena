// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE MACHINE AUDIT (kanban #1489, round 5, area node): update.lock (kanban #809: ONE update of a node at a time) is taken over when its
// holder is gone by read -> judge stale -> remove -> create. Two updaters that both find the same dead holder's lock (the auto updater's
// resume at boot and the desktop app's --update-self, after a crash left the lock) each judge it stale; the one that judges second removes
// the lock the first had just created for itself, and both hold "the" lock - two moves of one node at once, the #809 incident.
// The two processes are played in one: the first one's liveness check of the dead pid (process.kill(pid, 0), a real syscall point between the
// read and the remove) is where the second process runs its whole take-over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeUpdateLock, bootMinute } from '../src/update.js';

test('two updaters taking over one dead holder\'s update.lock both hold it', async () => {
  const home = join(mkdtempSync(join(tmpdir(), 'wf1489-sm5-node-3-')), 'home');
  mkdirSync(home, { recursive: true });
  const file = join(home, 'update.lock');
  const boot = bootMinute();
  // left by an updater that was killed (this boot, its pid gone)
  writeFileSync(file, JSON.stringify({ pid: 999991, atMs: Date.now(), boot }));
  const DEAD = 999991, A = 4242, B = 4343;
  let second = null;
  // waitLockMs 0: an updater that has to wait for the other one refuses at once - it does not hold the lock (the fix, kanban #1975)
  const refused = (e) => { assert.match(e.message, /another update of this node is still running/); return { file: null, refused: true }; };
  const aliveA = (p) => {
    if (p === DEAD && !second) {
      // process B runs now, between A's read of the dead lock and A's remove of it
      second = takeUpdateLock(home, { pid: B, boot, alive: (q) => q !== DEAD, sleep: async () => {}, waitLockMs: 0 }).catch(refused);
    }
    return p !== DEAD;
  };
  const a = await takeUpdateLock(home, { pid: A, boot, alive: aliveA, sleep: async () => {}, waitLockMs: 0 }).catch(refused);
  const b = await second;
  const onDisk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  console.log(`  A holds: ${!!a.file}; B holds: ${!!b.file}; the lock on disk names pid ${onDisk && onDisk.pid}`);
  // INVARIANT (#809): at most one update holds the node's lock
  assert.ok(!(a.file && b.file), 'two updaters hold the update lock of one node at once');
  // and the one that holds it is the one the lock on disk names: its release() frees the node
  assert.ok(a.file || b.file, 'neither updater took over the dead holder\'s lock');
  assert.equal(onDisk && onDisk.pid, a.file ? A : B);
});
