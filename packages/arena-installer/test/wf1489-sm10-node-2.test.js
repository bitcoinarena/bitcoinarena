// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM10 NODE-2: update.lock (kanban #809) names the machine's start in minutes (`boot`, kanban #1166), computed as wall clock minus
// uptime. A wall clock stepped by NTP after the lock was taken - a machine without a real-time clock that boots hours behind, then syncs; any
// NTP step of more than 2 minutes - moves every later reader's bootMinute, so a LIVE, seconds-old lock reads as "from before the machine
// started" and is taken over. Two updaters then move one node at once: the #809 failure (the second prunes the release folder the first
// moved the services to; the node stops with exit 78).
//
// Invariant: while the holder of update.lock is alive and its lock is fresh, no second updater holds the node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeUpdateLock, bootMinute } from '../src/update.js';

test('wf1489-sm10-node-2: an NTP step after an update took update.lock lets a second updater take the live lock', async () => {
  const h = mkdtempSync(join(tmpdir(), 'wf1489-sm10-node-2-'));
  const upSec = 90;                         // the auto updater's resume runs right after the machine started
  const before = 1_800_000_000_000;         // the wall clock as the machine booted it (behind: no real-time clock)
  // updater A (the auto update service's resume, or `bitcoinarena update`) takes the lock and works for a while: alive
  const a = await takeUpdateLock(h, { pid: 111, now: () => before, boot: bootMinute(before, upSec), alive: () => true, sleep: async () => {} });
  const heldA = JSON.parse(readFileSync(join(h, 'update.lock'), 'utf8'));
  // NTP steps the clock 7 minutes forward; 20 s later (uptime 110 s) updater B (the desktop app's update) asks for the node
  const after = before + 7 * 60_000 + 20_000;
  let b = null, waited = false;
  try {
    b = await takeUpdateLock(h, { pid: 222, now: () => after, boot: bootMinute(after, upSec + 20), alive: (p) => p === 111,
      waitLockMs: 50, sleep: async () => { waited = true; await new Promise((r) => setTimeout(r, 5)); }, onWait: () => { waited = true; } });
  } catch (e) { b = { refused: e.message }; }
  const holder = JSON.parse(readFileSync(join(h, 'update.lock'), 'utf8'));
  console.log(`wf1489-sm10-node-2: A's lock boot=${heldA.boot}; B's bootMinute=${bootMinute(after, upSec + 20)}; B ${b && b.refused ? `refused (${b.refused})` : `took the lock (waited=${waited})`}; update.lock now names pid ${holder.pid}`);
  assert.equal(holder.pid, 111, 'the live updater A still holds update.lock');
  assert.ok(b && b.refused, 'updater B waits for A and gives up with a reason - it never holds the node beside A');
  a.release();
});
