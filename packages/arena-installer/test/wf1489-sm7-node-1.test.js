// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM7 NODE-1: the rollback decides whether to keep the database (dbChangedSince, #1286) BEFORE it stops the new release.
// A new release that did not answer /identity within the wait is still running when moveNode reads the database's print; whatever it writes
// between that read and its stop (a nonce it used as it reached serve(), a lock, an entry - the #1286 case, a few ms later) is overwritten
// by the backup, because keepDb was already decided false. The invariant (#1166/#1227/#1286): a database the new release wrote is never
// replaced by the backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit } from '../src/update.js';
import { seatUnit, UNIT } from '../src/service.js';

const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

test('wf1489-sm7-node-1: what the new release writes between the print check and its stop is not overwritten by the backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm7-node-1-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 19000 + Math.floor(Math.random() * 1000);
  const rel = (v) => {
    const dir = join(root, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${createHash('sha256').update(v).digest('hex')}\n`);
    return dir;
  };
  const v1 = rel('0.1.0'), v2 = rel('0.1.1');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
  writeFileSync(join(home, 'node.db'), 'the database of the node\n');
  writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
  let running = v1;
  const sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    if (verb === 'stop' && names.includes(UNIT)) {
      // the new release, slow to start, is serving by now: it used a nonce just before its stop came (or on its way down)
      if (running === v2) appendFileSync(join(home, 'node.db'), 'nonce 9 used by 0.1.1 as the wait ran out\n');
      running = null;
    }
    if (verb === 'start' && names.includes(UNIT)) running = releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
    return { ok: true, out: '', err: '' };
  };
  const KEY = Buffer.alloc(32, 7);
  // the old release answers; the new one is still loading its games when the wait ends (no answer on /identity yet)
  const fetcher = async (url) => {
    if (running !== v1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const path = new URL(url).pathname;
    if (path === '/identity') return new Response(KEY, { status: 200 });
    if (path === '/owner/version') return new Response(JSON.stringify({ version: '0.1.0', commit: readFileSync(join(v1, 'COMMIT'), 'utf8').trim() }), { status: 200 });
    return new Response('', { status: 404 });
  };
  const r = await updateNode({ home, newRelease: v2, port, env, sh, fetcher, platform: 'linux', nowMs: () => 0, sleep: fast, waitMs: 1500,
    fetchApps: async () => ({ ok: true }), refreshGames: null });
  const db = readFileSync(join(home, 'node.db'), 'utf8');
  console.log(`  wf1489-sm7-node-1: rolled back ${r.rolledBack}, dbKept ${r.dbKept}; node.db ${db.includes('nonce 9') ? 'keeps' : 'FORGOT'} the nonce the new release used before its stop`);
  assert.equal(r.rolledBack, true);
  assert.equal(running, v1, 'the old release runs again');
  assert.ok(db.includes('nonce 9 used by 0.1.1'), 'the backup was put back over a nonce the new release used after the print was read and before it was stopped');
});
