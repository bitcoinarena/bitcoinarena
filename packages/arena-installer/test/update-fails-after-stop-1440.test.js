// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FAILURE AFTER THE NODE IS STOPPED (kanban #1440, audit 8 O8-1): anything that threw after update.js stopped the node - realistically a
// full disk while node.db is copied into backups/ - left it stopped, its journal at `stopping`, and no auto-update.json record, so the 24 h
// back-off of #1369 never applied: every 30 min check started the old release (the resume) and stopped it again. Now any failure after the
// stop rolls back and starts the old release, the auto updater records it as rolled back, and an update that has no room for the backup is
// refused before anything stops. A Linux node played with no process (the units' start and stop, the seat's answers), as in #1166.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit } from '../src/update.js';
import { checkOnce, assetNameFor } from '../src/auto-update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

/** A Linux node in a temp home, its units in a temp systemd folder; `sh` plays systemctl, `fetcher` plays the seat that runs. */
function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'update-1440-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const release = (v, behaves = {}) => {
    const dir = join(root, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${createHash('sha256').update(v).digest('hex')}\n`);
    rels.set(dir, behaves);
    return dir;
  };
  const rels = new Map();
  const node = { root, home, env, port, units, release, running: null, hangStartOf: null };
  node.calls = [];
  node.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    node.calls.push(`${verb} ${names.join(' ')}`);
    if (verb === 'stop' && names.includes(UNIT)) node.running = null;
    if (verb === 'start' && names.includes(UNIT)) {
      const rel = releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
      if (node.hangStartOf === rel) return new Promise(() => {});   // the updater dies here: its call never comes back
      node.running = rel;
      const b = rels.get(rel) || {};
      // it runs a while: signs (its database writes what it used), and keeps a WAL beside the database
      if (b.signs) appendFileSync(join(home, 'node.db'), `nonce 7 used by ${b.signs}\n`);
      if (b.wal) writeFileSync(join(home, 'node.db-wal'), `wal of ${rel}\n`);
    }
    return { ok: true, out: '', err: '' };
  };
  node.fetcher = async (url) => {
    const b = node.running && rels.get(node.running);
    if (!node.running || b.broken) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const path = new URL(url).pathname;
    if (path === '/identity') return new Response(KEY, { status: 200 });
    if (path === '/owner/version') {
      const v = b.answersAs || node.running;
      return new Response(JSON.stringify({ version: readFileSync(join(v, 'VERSION'), 'utf8').trim(), commit: readFileSync(join(v, 'COMMIT'), 'utf8').trim() }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  node.install = (v1) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), 'the database of the node\n');
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    node.running = v1;
  };
  node.update = (to, o = {}) => updateNode({ home, newRelease: to, port, env, sh: node.sh, fetcher: node.fetcher, platform: 'linux', nowMs: () => 0, sleep: fast,
    waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null, ...o });
  node.unitRelease = () => releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
  return node;
}
const journalOf = (n) => JSON.parse(readFileSync(join(n.home, 'update-journal.json'), 'utf8'));

/** 2026.1.9.27 served to checkOnce: its one piece, its hash in latest.json; `unpack` makes the folder the auto update moves to. */
function served27() {
  const v = '2026.1.9.27', name = assetNameFor(v, 'linux', 'x64'), bytes = Buffer.from('the release asset of 2026.1.9.27');
  const base = 'https://testnet.bitcoinarena.io/release/u/f/v2026.1.9.27/';
  const files = new Map([[`${name}.part00`, bytes], ['SHA256SUMS', Buffer.from('sums')], ['SHA256SUMS.sig', Buffer.from('sig')]]);
  const asked = [];
  const fetcher = async (url, o = {}) => { if (o.method !== 'HEAD') asked.push(url); const f = files.get(url.slice(base.length)); return f ? { status: 200, headers: new Headers(), arrayBuffer: async () => f } : { status: 404, arrayBuffer: async () => Buffer.alloc(0) }; };
  const latest = async (own) => ({ latest: { version: v, commit: 'c'.repeat(40), assets: { [name]: createHash('sha256').update(bytes).digest('hex') },
    download: { base, sums: 'SHA256SUMS', sig: 'SHA256SUMS.sig', parts: { [name]: [`${name}.part00`] } } }, newer: own !== v });
  const unpack = (archive, dir) => mkdirSync(join(dir, name.replace(/\.tar\.gz$/, '')), { recursive: true });
  return { fetcher, latest, unpack, asked, verifyAsset: () => ({ ok: true }) };
}

test('#1440 a backup that fails after the stop rolls back: the old release runs again, the journal ends rolled back', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27');
    n.install(v1);
    writeFileSync(join(n.home, 'backups'), 'not a folder: the backup cannot be written (stands in for ENOSPC while node.db is copied)\n');
    let r = null, threw = null;
    try { r = await n.update(v2); } catch (e) { threw = e.message; }
    assert.equal(threw, null, 'the update answers, it does not throw');
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.match(r.why, /ENOTDIR|backups/);
    assert.equal(n.running, v1, 'the old release runs again');
    assert.equal(n.unitRelease(), v1, 'the seat unit names the old release');
    assert.equal(journalOf(n).phase, 'rolled-back');
    assert.ok(n.calls.lastIndexOf(`start ${UNIT}`) > n.calls.lastIndexOf(`stop ${UNIT}`), 'started after the last stop');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1440 a service file that cannot be written after the backup: the rollback starts the old release (its own write failing too)', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27');
    n.install(v1);
    const unit = join(n.units, UNIT);
    const sh0 = n.sh;
    let once = true;
    // the node is stopped, then its unit file turns read-only: writing the new unit throws (EACCES), and so does the rollback's write of the old text
    n.sh = async (c, a) => { const out = await sh0(c, a); if (once && a[1] === 'stop') { once = false; chmodSync(unit, 0o444); } return out; };
    let r = null, threw = null;
    try { r = await n.update(v2); } catch (e) { threw = e.message; }
    chmodSync(unit, 0o644);
    assert.equal(threw, null, 'the update answers, it does not throw');
    assert.equal(r.rolledBack, true);
    assert.match(r.why, /EACCES|permission/);
    assert.ok(existsSync(join(r.backup || '', 'node.db')), 'the backup was made');
    assert.equal(n.running, v1, 'the old release runs again');
    assert.equal(journalOf(n).phase, 'rolled-back');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1440 the auto updater records the failed move as rolled back: the next check within 24 h stops nothing', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27');
    n.install(v1);
    writeFileSync(join(n.home, 'backups'), 'not a folder\n');
    const s = served27();
    const o = { home: n.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: s.verifyAsset, unpack: s.unpack, apply: () => n.update(v2) };
    let first = null;
    try { first = await checkOnce(o); } catch (e) { first = { threw: e.message }; }
    assert.equal(first.rolledBack, true, JSON.stringify(first));
    assert.equal(n.running, v1);
    const rec = JSON.parse(readFileSync(join(n.home, 'auto-update.json'), 'utf8'));
    assert.equal(rec.rolledBack, true); assert.equal(rec.to, '2026.1.9.27');
    n.calls.length = 0;
    const second = await checkOnce(o);
    assert.match(String(second.skipped), /rolled back on this node/);
    assert.deepEqual(n.calls.filter((c) => c.startsWith('stop')), [], 'nothing stopped by the next check');
    assert.equal(n.running, v1);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1440 an update that throws is recorded too, so the back-off holds', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26');
    n.install(v1);
    const s = served27();
    let applied = 0;
    const o = { home: n.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: s.verifyAsset, unpack: s.unpack,
      apply: async () => { applied++; throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); } };
    await assert.rejects(checkOnce(o), /ENOSPC/);
    const rec = JSON.parse(readFileSync(join(n.home, 'auto-update.json'), 'utf8'));
    assert.equal(rec.rolledBack, true); assert.equal(rec.to, '2026.1.9.27'); assert.match(rec.why, /ENOSPC/);
    const second = await checkOnce(o);
    assert.match(String(second.skipped), /rolled back on this node/);
    assert.equal(applied, 1);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1440 no room for the backup: the update is refused before anything stops, the node keeps running', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27');
    n.install(v1);
    writeFileSync(join(n.home, 'node.db'), Buffer.alloc(4096, 1));
    const r = await n.update(v2, { freeBytes: () => 1024 });
    assert.equal(r.ok, false);
    assert.match(r.why, /not enough free disk space/);
    assert.equal(r.rolledBack, undefined, 'nothing to roll back');
    assert.deepEqual(n.calls.filter((c) => c.startsWith('stop')), [], 'nothing stopped');
    assert.equal(n.running, v1);
    assert.equal(existsSync(join(n.home, 'update-journal.json')), false, 'no journal begun');
    assert.equal(existsSync(join(n.home, 'backups')), false, 'no backup begun');
    // and with room it goes ahead
    const ok = await n.update(v2, { freeBytes: () => 64 * 2 ** 30 });
    assert.equal(ok.ok, true, ok.why);
    assert.equal(n.running, v2);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1440 the auto updater refuses to download a release it has no room for: nothing fetched, nothing moved', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26');
    n.install(v1);
    const s = served27();
    let applied = 0;
    const r = await checkOnce({ home: n.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: s.verifyAsset, unpack: s.unpack,
      apply: async () => { applied++; return { ok: true }; }, freeBytes: () => 50 * 2 ** 20 });
    assert.equal(r.ok, false);
    assert.match(r.why, /not enough free disk space/);
    assert.equal(applied, 0);
    assert.deepEqual(s.asked, [], 'no piece fetched');
    assert.equal(r.rolledBack, undefined);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
