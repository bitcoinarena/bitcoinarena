// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM10 NODE-1: a guardian whose start meets a bitcoind that does not answer for a minute (a machine reboot: the node's own Core is
// still loading its block index; a Core restart while fedimintd exited) is left `running: false` - and node-start.js's exitWatch and
// cookieWatch only look at a guardian that is `running`. Nothing starts it again once bitcoind answers: the node serves on without its
// guardian until its process is restarted by hand (the federation one guardian short; f + 1 of them halts it).
//
// Invariant: a node that holds a guardian key (plan.own) and whose owner did not stop it runs its guardian again once the chain answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
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

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'fedimintd'), '#!/bin/sh\nexec sleep 300\n');
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const path = join(dir, 'n.db');
  mkdirSync(`${path}.guardian`, { recursive: true });
  writeFileSync(`${path}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${path}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
  // bitcoind: down while `down` is true (a Core still loading its block index answers -28 the same way)
  const bitcoind = { down: false, asked: 0 };
  const call = async () => { bitcoind.asked++; if (bitcoind.down) throw new Error('Loading block index... (-28)'); return { chain: 'testnet4' }; };
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call, tailscale: null, log: () => {},
    env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_GUARDIAN_EXIT_WATCH_MS: '300', ARENA_COOKIE_WATCH_MS: '300' } };
  return { dir, path, chain, bitcoind };
}

test('wf1489-sm10-node-1a: a guardian whose boot start met a bitcoind still loading is never started once bitcoind answers', { timeout: 115000 }, async () => {
  const f = fixture('wf1489-sm10-node-1a-');
  f.bitcoind.down = true;   // the machine just rebooted: Core answers nothing for more than the guardian's minute of tries
  const p = await port(24311);
  const n = await startNode({ db: openStore(f.path), path: f.path }, { port: p, plugins: [NEXTBLOCK] }, f.chain);
  try {
    const askedAtBoot = f.bitcoind.asked;
    assert.equal(n.guardianControl.has(), true, 'the node holds a guardian key');
    assert.equal(n.guardianControl.running(), false, 'its boot start gave up on the chain');
    f.bitcoind.down = false;   // Core is up now
    await sleep(4000);         // more than ten exitWatch / cookieWatch passes
    console.log(`wf1489-sm10-node-1a: bitcoind asked ${askedAtBoot} times at boot, ${f.bitcoind.asked - askedAtBoot} times after it answered; guardian running=${n.guardianControl.running()}`);
    assert.equal(n.guardianControl.running(), true, 'a keyed guardian the owner never stopped runs again once bitcoind answers');
  } finally { await n.close(); }
});

test('wf1489-sm10-node-1b: a guardian that exited while bitcoind restarted is never started again once bitcoind answers', { timeout: 115000 }, async () => {
  const f = fixture('wf1489-sm10-node-1b-');
  const p = await port(24411);
  const n = await startNode({ db: openStore(f.path), path: f.path }, { port: p, plugins: [NEXTBLOCK] }, f.chain);
  try {
    assert.equal(n.guardianControl.running(), true, 'started at boot');
    // bitcoind restarts (a Core update, an out-of-memory kill) and fedimintd exits with it
    f.bitcoind.down = true;
    process.kill(n.guardians.own.pid, 'SIGKILL');
    // exitWatch tries again within 300 ms and spends its minute of tries on a chain that does not answer
    const until = Date.now() + 75000;
    while (Date.now() < until && n.guardianControl.running()) await sleep(500);
    assert.equal(n.guardianControl.running(), false, 'the restart gave up on the chain');
    f.bitcoind.down = false;
    // exitWatch waits 60 s per slot between restarts: give it that and more
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !n.guardianControl.running()) await sleep(500);
    console.log(`wf1489-sm10-node-1b: guardian running after bitcoind came back: ${n.guardianControl.running()}`);
    assert.equal(n.guardianControl.running(), true, 'the guardian runs again once bitcoind answers');
  } finally { await n.close(); }
});
