// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (node lifecycle): THE GUARDIAN STARTED FROM THE OWNER PAGE TWICE AT ONCE (POST /owner/service {id: guardian,
// action: start | restart}, server.js -> node-start.js guardianControl.start). start() checks `guardian.running` and only sets `guardian` after
// `await start('guardian')` (startGuardian reads the chain, the ports, Tailscale ... before it spawns), so two signed asks in flight together - two
// tabs, a double click on Restart, a page retry - both see no guardian and both spawn a fedimintd on the same data dir. The handle of the first is
// overwritten: nothing holds it any more, so the owner's Stop (and node.close) ends only the second, and the first fedimintd keeps running - a
// guardian the owner can no longer stop from the page, beside a second one fighting it for the same database and ports.
// Invariant (docs/STATE-MACHINES.md SM-L1): one fedimintd per data dir, and every one the node started is one it can stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startNode } from '../src/node-start.js';

const port = (from) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(port(from + 7)));
  s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('wf1489-sm2-node-2: two owner starts of the guardian at once start one fedimintd, and the owner\'s Stop ends every one started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-node-2-'));
  // a stand-in fedimintd (as node-start.test.js): it notes its pid and waits to be stopped
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const started = join(dir, 'fedimintd-started');
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\necho $$ >> ${started}\nexec sleep 60\n`);
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => ({ chain: 'testnet4' }),
    env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: null, log: () => {} };
  // a founded guardian: the two files a completed ceremony writes
  const path = join(dir, 'a.db');
  mkdirSync(`${path}.guardian`, { recursive: true });
  writeFileSync(`${path}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${path}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
  const pids = async (n) => { for (let t = 0; t < 50; t++) { const l = existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean).map(Number) : []; if (l.length >= n) return l; await sleep(100); } return existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean).map(Number) : []; };
  const node = await startNode({ db: openStore(path), path }, { port: await port(23411) }, chain);
  let all = [];
  try {
    const control = node.guardianControl;
    assert.equal(control.running(), true, 'the guardian started with the node');
    await pids(1);
    // the owner stops it, then (two tabs / a double click) asks to start it twice
    assert.equal((await control.stop()).ok, true);
    const [a, b] = await Promise.all([control.start(), control.start()]);
    assert.deepEqual([a.ok, b.ok], [true, true]);
    await sleep(1500);
    all = await pids(1);
    const live = all.filter(alive);
    // the owner stops it again: every fedimintd the node started must end
    assert.equal((await control.stop()).ok, true);
    await sleep(1500);
    const left = all.filter(alive);
    assert.deepEqual({ runningAfterStarts: live.length, runningAfterStop: left.length }, { runningAfterStarts: 1, runningAfterStop: 0 },
      `started ${all.length} fedimintd(s) in all; after the two owner starts ${live.length} ran on ${path}.guardian, after the owner's Stop ${left.length} still run (pids ${left.join(', ')}) - a guardian nothing in the node can stop`);
  } finally {
    await node.close();
    for (const p of all) if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
});
