// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-6): A CUSTODY ADD WHOSE RUNNER DIED BLOCKS THE OWNER FOR SIX HOURS.
// POST /owner/custody (add-custody.js startCustodyAdd) writes custody-add.json { state: 'running' }, takes the request file and starts
// bin/custody-add.mjs detached; the runner writes its progress as it goes and waits up to a day for the wallet's funds (state 'funds', a line a
// minute). The progress file names no process: a runner that is gone (the machine restarted - it is started by nothing at boot -, the runner
// was killed, it crashed) leaves its last state - 'running', 'funds', 'lightning', 'gateway' - and every start is refused "custody is being
// added already" until STALE_MS (6 h) after its last line, with nothing running and the request file already taken. The gateway-only setup
// (startGatewaySetup) is held the same way. Invariant: "being added already" only while a runner is alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCustodyAdd, custodyProgress } from '../src/add-custody.js';

test('sm1-node-6 the custody runner is gone (the machine restarted): the owner can start custody again, not after six hours', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-6-'));
  const home = join(root, 'home'), release = join(root, 'release');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(release, 'packages', 'arena-installer', 'bin'), { recursive: true });
  writeFileSync(join(release, 'packages', 'arena-installer', 'bin', 'custody-add.mjs'), '// the runner\n');
  // the runner a test would spawn: a process that ends at once (as one the machine's restart ended)
  const spawned = [];
  const run = (cmd, args) => { spawned.push(args); return { unref() {}, pid: 2 ** 22 + 7 }; };
  const t0 = 1_800_000_000_000;
  const first = startCustodyAdd({ home, release, understood: 'I UNDERSTAND', nowMs: t0, run });
  assert.equal(first.ok, true);
  // the runner's last line before it was gone: waiting for the funds
  writeFileSync(join(home, 'custody-add.json'), JSON.stringify({ state: 'funds', step: 'waiting for the wallet', atMs: t0 + 60_000 }) + '\n');
  // an hour later nothing runs; the owner presses "Add custody" again
  const again = startCustodyAdd({ home, release, understood: 'I UNDERSTAND', nowMs: t0 + 3_600_000, run });
  console.log(`  sm1-node-6: second start ${again.ok ? 'started' : `refused (${again.status}: ${again.why})`}; progress ${custodyProgress(home).state}; runners started ${spawned.length}`);
  assert.equal(again.ok, true, 'a runner that is gone does not hold the next start for six hours');
  assert.equal(spawned.length, 2);
});

test('sm1-node-6 a runner from before the machine last started: interrupted, started again; a live runner still holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-6b-'));
  const home = join(root, 'home'), release = join(root, 'release');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(release, 'packages', 'arena-installer', 'bin'), { recursive: true });
  writeFileSync(join(release, 'packages', 'arena-installer', 'bin', 'custody-add.mjs'), '// the runner\n');
  const spawned = [];
  const run = (cmd, args) => { spawned.push(args); return { unref() {}, pid: process.pid }; };
  const t0 = 1_800_000_000_000;
  assert.equal(startCustodyAdd({ home, release, understood: 'I UNDERSTAND', nowMs: t0, run }).ok, true);
  writeFileSync(join(home, 'custody-add.json'), JSON.stringify({ state: 'funds', atMs: t0 + 60_000 }) + '\n');
  // the runner is alive (this process): held, as before
  const held = startCustodyAdd({ home, release, understood: 'I UNDERSTAND', nowMs: t0 + 120_000, run });
  assert.deepEqual([held.ok, held.status, spawned.length], [false, 409, 1]);
  assert.equal(custodyProgress(home).interrupted, undefined);
  // the same pid after a restart is another process: the record's boot minute decides
  const later = { boot: Math.round(Date.now() / 60000) + 600, alive: () => true };
  assert.equal(custodyProgress(home, later).interrupted, true);
  assert.equal(startCustodyAdd({ home, release, understood: 'I UNDERSTAND', nowMs: t0 + 180_000, run, runner: later }).ok, true);
  assert.equal(spawned.length, 2);
});
