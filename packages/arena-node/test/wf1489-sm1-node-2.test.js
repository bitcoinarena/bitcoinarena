// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit sm1 (node lifecycle: guardian start/stop from the owner page x a restart). Gap in #3606 ("the owner's
// stop survives an update"): #3606 keeps an owner-stopped installer UNIT stopped across moveNode, but the guardian is not a unit - the
// seat runs it (node-start.js guardianControl). The owner's Stop only sets `wanted.guardian = false` in memory; the seat's restart (every
// auto update restarts the seat, also a crash or the owner's own "restart node") computes wanted from the "at boot" switch alone and
// starts fedimintd again. The owner page then shows the guardian running though nobody started it.
// Invariant: a guardian the owner stopped stays stopped until the owner starts it (#2336: "only the owner's stop ... clears it").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startNode } from '../src/node-start.js';

const port = (from) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(port(from + 7)));
  s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
});

test('wf1489-sm1-node-2: a guardian the owner stopped is started again by the seat\'s restart (auto update, crash)', { timeout: 115000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-node-2-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'fedimintd'), '#!/bin/sh\nexec sleep 300\n');
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const path = join(dir, 'n.db');
  mkdirSync(`${path}.guardian`, { recursive: true });
  writeFileSync(`${path}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${path}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => ({ chain: 'testnet4' }), tailscale: null, log: () => {},
    env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_GUARDIAN_EXIT_WATCH_MS: '300', ARENA_COOKIE_WATCH_MS: '300' } };
  const p = await port(24611);
  const n1 = await startNode({ db: openStore(path), path }, { port: p, plugins: [] }, chain);
  let n2 = null;
  try {
    assert.equal(n1.guardianControl.running(), true, 'started at boot');
    const r = await n1.guardianControl.stop();   // the owner page: Guardian -> Stop
    assert.equal(r.ok, true);
    assert.equal(n1.guardianControl.running(), false, 'stopped by the owner');
    await n1.close();
    // the auto updater moves the node to the next release: the seat's unit is stopped and started again (same store, same settings)
    n2 = await startNode({ db: openStore(path), path }, { port: p, plugins: [] }, chain);
    console.log(`wf1489-sm1-node-2: after the owner's stop and one seat restart the guardian runs: ${n2.guardianControl.running()} (pid ${n2.guardians.own ? n2.guardians.own.pid : '-'})`);
    assert.equal(n2.guardianControl.running(), false, 'the guardian the owner stopped runs again after the seat restarted');
  } finally { if (n2) await n2.close(); }
});
