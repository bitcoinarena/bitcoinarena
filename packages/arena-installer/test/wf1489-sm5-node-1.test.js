// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE MACHINE AUDIT (kanban #1489, round 5, area node): the update journal's KEPT write fails (a full disk: #1440's own case) after moveNode
// already wrote state.json's release. failedAfterStop rolls the node back to the old release, but state.json is never restored (NEVER_RESTORED),
// so it names the new release while the units run the old one. nodeOf() reads the running version from state.json: the auto updater then
// answers "up to date" for that release for good, and `bitcoinarena update` (force) too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit } from '../src/update.js';
import { checkOnce } from '../src/auto-update.js';
import { nodeOf } from '../src/node-services.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm5-node-1-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const rels = new Map();
  const release = (v) => {
    const dir = join(home, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${createHash('sha256').update(v).digest('hex')}\n`);
    rels.set(dir, {});
    return dir;
  };
  const node = { root, home, env, port, units, release, running: null };
  node.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    if (verb === 'stop' && names.includes(UNIT)) node.running = null;
    if (verb === 'start' && names.includes(UNIT)) node.running = releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
    return { ok: true, out: '', err: '' };
  };
  node.fetcher = async (url) => {
    if (!node.running) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const path = new URL(url).pathname;
    if (path === '/identity') return new Response(KEY, { status: 200 });
    if (path === '/owner/version') return new Response(JSON.stringify({ version: readFileSync(join(node.running, 'VERSION'), 'utf8').trim(), commit: readFileSync(join(node.running, 'COMMIT'), 'utf8').trim() }), { status: 200 });
    return new Response('', { status: 404 });
  };
  node.install = (v1) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), 'the database of the node\n');
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    node.running = v1;
  };
  node.unitRelease = () => releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
  return node;
}

test('a failed KEPT write rolls the node back but leaves state.json naming the new release: the auto updater says up to date for good', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0'), v2 = n.release('0.1.1');
  n.install(v1);
  // the disk is full for the one write of the journal's KEPT step (everything before it, state.json included, went through)
  const realWriteSync = fs.writeSync;
  let failedOnce = false;
  fs.writeSync = function (fd, data, ...rest) {
    if (!failedOnce && typeof data === 'string' && data.includes('"phase": "kept"')) { failedOnce = true; throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }
    return realWriteSync.call(this, fd, data, ...rest);
  };
  syncBuiltinESMExports();
  let r;
  try {
    r = await updateNode({ home: n.home, newRelease: v2, port: n.port, env: n.env, sh: n.sh, fetcher: n.fetcher, platform: 'linux', nowMs: () => 0, sleep: fast,
      waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null });
  } finally { fs.writeSync = realWriteSync; syncBuiltinESMExports(); }
  const st = JSON.parse(readFileSync(join(n.home, 'state.json'), 'utf8'));
  const journal = JSON.parse(readFileSync(join(n.home, 'update-journal.json'), 'utf8'));
  const tail = (p) => (p ? p.split('-').at(-3) : 'none');
  console.log(`  KEPT write failed: ${failedOnce}; update ${r.ok ? 'ok' : r.rolledBack ? 'rolled back' : r.why}; journal ${journal.phase}; the seat runs ${tail(n.running)}, its unit names ${tail(n.unitRelease())}; state.json release ${tail(st.release && st.release.path)}; nodeOf version ${nodeOf(n.home).version}`);
  assert.ok(failedOnce, 'the KEPT write was the one that failed');
  assert.equal(r.rolledBack, true, 'the update was rolled back');
  assert.equal(n.unitRelease(), v1, 'the units run the old release again');
  // the node asks the newest release as the auto updater does: 0.1.1 is out
  const latest = async (own) => ({ latest: { version: '0.1.1', assets: {}, download: null }, newer: own !== '0.1.1' });
  const check = await checkOnce({ home: n.home, latest, force: true, apply: async () => ({ ok: true }) });
  console.log(`  the next check (bitcoinarena update, forced): ${JSON.stringify(check)}`);
  // INVARIANT: the release state.json records is the one the node's units run
  assert.equal((st.release || {}).path, n.unitRelease(), 'state.json names the release the node runs');
  assert.notEqual(check.upToDate, true, 'a node running 0.1.0 is not up to date with 0.1.1');
});
