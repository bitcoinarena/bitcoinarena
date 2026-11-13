// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-3): A ROLLBACK INTERRUPTED WHILE IT PUTS node.db BACK IS FINISHED WITH THE
// HALF-COPIED DATABASE KEPT. The updater's rollback of a release that never answered and wrote nothing decides "the backup goes back"
// (journal ROLLING_BACK, served: false) and then copies backups/<stamp>/node.db over the home's node.db (copyFileSync: truncate, then
// write - about 1 GB on a seat, seconds; on Windows each busy file after it is retried for 30 s). An updater killed in that window
// (a reboot, a kill, power) leaves node.db half copied.
// resumeUpdate then asks dbChangedSince(home, backup) - and the copy it made itself changed the print (size / mtime) - so it decides
// "node.db changed since the backup: kept", puts back nothing of the seat's data and starts the old release on a torn database.
// Invariant: a rollback that decided to put the backup back (served false) ends with node.db equal to the backup, whatever restarts between.
// Played on a Linux node with no process at all (the update-journal-1166 fixture): units, systemctl and the seat's answers are the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, resumeUpdate, readJournal, releaseOfUnit } from '../src/update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-3-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const rels = new Map();
  const release = (v, behaves = {}) => {
    const dir = join(root, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${createHash('sha256').update(v).digest('hex')}\n`);
    rels.set(dir, behaves);
    return dir;
  };
  const node = { root, home, env, port, units, release, running: null, hangStop: false };
  node.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    if (verb === 'stop' && names.includes(UNIT)) {
      // the rollback's own stop: from here the updater is killed (the test then lays down what the copy left)
      if (node.hangStop) return new Promise(() => {});
      node.running = null;
    }
    if (verb === 'start' && names.includes(UNIT)) {
      const rel = releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
      node.running = rel;
      const b = rels.get(rel) || {};
      if (b.wal) writeFileSync(join(home, 'node.db-wal'), `wal of ${rel}\n`);
      if (b.onStart) b.onStart();
    }
    return { ok: true, out: '', err: '' };
  };
  node.fetcher = async (url) => {
    const b = node.running && rels.get(node.running);
    if (!node.running || b.broken) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const path = new URL(url).pathname;
    if (path === '/identity') return new Response(KEY, { status: 200 });
    if (path === '/owner/version') return new Response(JSON.stringify({ version: readFileSync(join(node.running, 'VERSION'), 'utf8').trim(), commit: readFileSync(join(node.running, 'COMMIT'), 'utf8').trim() }), { status: 200 });
    return new Response('', { status: 404 });
  };
  node.install = (v1, db) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), db);
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    node.running = v1;
  };
  node.opts = { home, port, env, sh: node.sh, fetcher: node.fetcher, platform: 'linux', nowMs: () => 0, sleep: fast, waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null };
  return node;
}

async function untilRollingBack(n) {
  for (let i = 0; i < 400; i++) {
    const j = readJournal(n.home);
    if (j && j.phase === 'rolling-back') return j;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('the fixture: the update never reached rolling-back');
}

const DB = 'SQLite format 3\0' + 'page of the seat: nonce 41 used, entry e7 locked, lock L3 kept\n'.repeat(400);

test('sm1-node-3 an updater killed while its rollback copies node.db back: the resume keeps the half-copied database', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0');
  // a release that never answers here and writes nothing: the updater rolls it back with the whole backup (served false)
  const v2 = n.release('0.1.1', { broken: true, onStart: () => { n.hangStop = true; } });
  n.install(v1, DB);
  updateNode({ ...n.opts, newRelease: v2 }).catch(() => {});
  const j = await untilRollingBack(n);
  assert.equal(j.served, false, 'the fixture: the rollback decided to put the backup back');
  assert.ok(j.backup && existsSync(join(j.backup.dir, 'node.db')), 'the fixture: a backup of node.db');
  // the updater dies inside restoreNode: copyFileSync(backup/node.db -> home/node.db) had truncated the file and written part of it
  writeFileSync(join(n.home, 'node.db'), DB.slice(0, 4096));
  // the machine restarts: the auto updater's service finishes the journal (runAutoUpdate -> resumeUnderLock -> resumeUpdate)
  n.hangStop = false;
  const r = await resumeUpdate({ ...n.opts });
  const db = readFileSync(join(n.home, 'node.db'), 'utf8');
  const after = readJournal(n.home);
  console.log(`  sm1-node-3 resumed: ${r && r.resumed} (${r && r.why}); dbKept ${r && r.dbKept}; node.db ${db === DB ? 'is the backup again' : `is the HALF COPY (${db.length} of ${DB.length} bytes)`}; the old release ${n.running === v1 ? 'runs on it' : 'does not run'}; journal ${after.phase}`);
  assert.equal(r.resumed, 'rolled-back');
  assert.equal(db.length, DB.length, 'a rollback that decided to put the backup back left a torn node.db: the resume kept the half copy it had made itself');
  assert.ok(db === DB, 'node.db is the backup');
});

