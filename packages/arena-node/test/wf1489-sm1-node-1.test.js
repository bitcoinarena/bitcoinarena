// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-1): THE GUARDIAN THE OWNER PAGE STARTS AND STOPS (node-start.js guardianControl,
// POST /owner/service { id: 'guardian' }). Invariant: one fedimintd per guardian data dir, and the node tracks the one that runs - an owner's
// stop that answered ok leaves none running, and closing the node leaves none behind.
// The handle `guardian` is read before an await and written after it, with nothing serialising start / stop:
//   - two starts at once (a double click, two owner tabs, a retried request) both see "not running" and both spawn fedimintd on the same
//     data dir; the node tracks only the last, the first runs on untracked - the owner's stop and the node's close never end it;
//   - a stop while a start is in flight (startGuardian waits on bitcoind up to a minute) answers ok and the start then sets the guardian running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startNode } from '../src/node-start.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const port = (from) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(port(from + 7)));
  s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
});
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// a stand-in fedimintd: notes its pid, then waits to be stopped
function standIn(dir, { chainMs = 0 } = {}) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const pids = join(dir, 'fedimintd-pids');
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\necho $$ >> ${pids}\nexec sleep 60\n`);
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => { if (chainMs) await sleep(chainMs); return { chain: 'testnet4' }; },
    env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_COOKIE_WATCH_MS: '3600000', ARENA_GUARDIAN_EXIT_WATCH_MS: '3600000' }, tailscale: null, log: () => {} };
  const alive = () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [])
    .filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  const spawned = () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).length : 0);
  return { chain, alive, spawned, pids };
}
function founded(storePath) {
  mkdirSync(`${storePath}.guardian`, { recursive: true });
  writeFileSync(`${storePath}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${storePath}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
}
const waitSpawned = async (s, n) => { for (let t = 0; t < 50 && s.spawned() < n; t++) await sleep(100); };
const killAll = (s) => { for (const p of s.alive()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

test('sm1-node-1a two owner starts at once run ONE fedimintd on the guardian data dir, and closing the node leaves none behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-1a-'));
  const s = standIn(dir);
  const path = join(dir, 'a.db'); founded(path);
  const n = await startNode({ db: openStore(path), path }, { port: await port(23411), plugins: [NEXTBLOCK] }, s.chain);
  try {
    await waitSpawned(s, 1);
    const c = n.guardianControl;
    assert.equal(c.running(), true, 'the keyed guardian runs from the start');
    assert.deepEqual(await c.stop(), { ok: true });
    await sleep(300);
    assert.equal(s.alive().length, 0, 'stopped: no fedimintd runs');
    // the owner page's Start, sent twice (double click / two tabs / a resend)
    const [a, b] = await Promise.all([c.start(), c.start()]);
    assert.deepEqual([a.ok, b.ok], [true, true]);
    await waitSpawned(s, 3); await sleep(200);
    const running = s.alive();
    console.log(`  sm1-node-1a: after two concurrent starts, ${running.length} fedimintd run on ${path}.guardian (spawned in all: ${s.spawned()})`);
    assert.equal(running.length, 1, `one fedimintd per guardian data dir - ${running.length} run`);
  } finally {
    await n.close();
    await sleep(300);
    const left = s.alive();
    console.log(`  sm1-node-1a: after the node closed, ${left.length} fedimintd still run`);
    killAll(s);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(left.length, 0, 'closing the node ends every fedimintd it started');
  }
});

test('sm1-node-1b an owner stop that answered ok while a start was in flight leaves no guardian running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-1b-'));
  const s = standIn(dir, { chainMs: 400 });   // bitcoind slow to answer (startGuardian asks it before it spawns)
  const path = join(dir, 'b.db'); founded(path);
  const n = await startNode({ db: openStore(path), path }, { port: await port(23511), plugins: [NEXTBLOCK] }, s.chain);
  try {
    await waitSpawned(s, 1);
    const c = n.guardianControl;
    await c.stop(); await sleep(300);
    const starting = c.start();               // Start ...
    await sleep(50);
    const stopped = await c.stop();           // ... then Stop, before the start returned
    assert.equal(stopped.ok, true, 'the stop answers ok');
    await starting; await waitSpawned(s, 2); await sleep(200);
    console.log(`  sm1-node-1b: the owner's last word was stop (answered ${JSON.stringify(stopped)}); the node says running=${c.running()}, ${s.alive().length} fedimintd run`);
    assert.equal(c.running() || s.alive().length > 0, false, 'after the stop that answered ok, no guardian runs');
  } finally { await n.close(); await sleep(200); killAll(s); rmSync(dir, { recursive: true, force: true }); }
});
