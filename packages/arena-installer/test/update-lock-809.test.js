// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE UPDATE OF A NODE AT A TIME (kanban #809, the owner 2026-10-30: the desktop app's update and the auto-updater moved his node to 2026.1.9.19
// at once; the second removed the folder the first had moved the services to, and the node stopped with exit 78).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeUpdateLock } from '../src/update.js';

const home = () => mkdtempSync(join(tmpdir(), 'arena-809-'));
const quick = { sleep: () => new Promise((r) => setTimeout(r, 5)) };

test('a second update waits while the first holds the node, then takes it', async () => {
  const h = home();
  const first = await takeUpdateLock(h, { pid: 111, alive: () => true, ...quick });
  let waitedFor = null, got = null;
  const second = takeUpdateLock(h, { pid: 222, alive: (p) => p === 111, onWait: (held) => { waitedFor = held.pid; }, ...quick }).then((l) => { got = l; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got, null, 'still waiting while the first holds it');
  assert.equal(waitedFor, 111);
  first.release();
  await second;
  assert.equal(got.waited, true);
  got.release();
  assert.equal(existsSync(join(h, 'update.lock')), false);
});

test('a lock whose update has ended, or that is too old, is taken over; one held too long makes the second stop with a reason', async () => {
  const h = home();
  writeFileSync(join(h, 'update.lock'), JSON.stringify({ pid: 999, atMs: Date.now() }));
  const l = await takeUpdateLock(h, { pid: 1, alive: () => false, ...quick });
  assert.equal(l.waited, false); l.release();
  writeFileSync(join(h, 'update.lock'), JSON.stringify({ pid: 999, atMs: 0 }));
  (await takeUpdateLock(h, { pid: 1, alive: () => true, ...quick })).release();
  writeFileSync(join(h, 'update.lock'), JSON.stringify({ pid: 999, atMs: Date.now() }));
  await assert.rejects(takeUpdateLock(h, { pid: 1, alive: () => true, waitLockMs: 30, ...quick }), /another update of this node is still running \(pid 999\)/);
});
