// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE UPDATE'S JOURNAL (kanban #1166, the state machine audit 2026-11-06): move -> verify -> keep or roll back kept the old unit texts
// and the backup's path in memory only. Measured here before and after, on a Linux node played with no process at all (the units' start
// and stop, the seat's answers): an updater that dies after writing the units; a rollback after the new release answered (and signed);
// a partial unpack; an update lock left from before a reboot. Every test names its platform and its own home - nothing of this machine's
// services is read or written. Only functions any installer has are called, so it runs against the source before #1166 too (and fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { updateNode, takeUpdateLock, releaseOfUnit } from '../src/update.js';
import { checkOnce, assetNameFor } from '../src/auto-update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

/** A Linux node in a temp home, its units in a temp systemd folder; `sh` plays systemctl, `fetcher` plays the seat that runs. */
function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'journal-1166-'));
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
  node.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
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
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
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
/** The updater "dies": its lock left behind as a dead process's lock is (taken over at once). */
const updaterDied = (n) => writeFileSync(join(n.home, 'update.lock'), JSON.stringify({ pid: 999999, atMs: Date.now() }));

test('the updater dies after writing the units; the next run verifies the new release and keeps it', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0'), v2 = n.release('0.1.1');
  n.install(v1);
  n.hangStartOf = v2;
  n.update(v2).catch(() => {});
  await new Promise((ok) => setTimeout(ok, 300));
  updaterDied(n);
  n.hangStartOf = null;
  const r = await n.update(v2).catch((e) => ({ ok: false, why: e.message }));
  const st = JSON.parse(readFileSync(join(n.home, 'state.json'), 'utf8'));
  console.log(`  #1166 died after the units, v2 healthy: next run ${r.ok ? 'ok' : `"${r.why}"`}; the seat runs ${n.running ? n.running.split('-').at(-3) : 'NOTHING'}; state.json release ${st.release ? st.release.path.split('-').at(-3) : 'not recorded'}`);
  assert.equal(n.running, v2, 'the node runs again, on the new release');
  assert.equal((st.release || {}).path, v2, 'the release recorded');
  assert.equal(r.ok, true, r.why);
  rmSync(n.root, { recursive: true, force: true });
});

test('the updater dies after writing the units of a release that does not start; the next run rolls it back', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0'), v2 = n.release('0.1.1', { broken: true });
  n.install(v1);
  n.hangStartOf = v2;
  n.update(v2).catch(() => {});
  await new Promise((ok) => setTimeout(ok, 300));
  updaterDied(n);
  n.hangStartOf = null;
  const r = await n.update(v2).catch((e) => ({ ok: false, why: e.message }));
  console.log(`  #1166 died after the units, v2 broken: next run "${r.why}"; the seat runs ${n.running ? n.running.split('-').at(-3) : 'NOTHING'}; its unit names ${n.unitRelease().split('-').at(-3)}`);
  assert.equal(n.running, v1, 'the old release runs again');
  assert.equal(n.unitRelease(), v1, 'its unit names it');
  rmSync(n.root, { recursive: true, force: true });
});

test('a rollback after the new release answered as this node keeps the database it signed with; one that never answered gets the backup, its WAL dropped', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0');
  // answers as this node, signs, but answers with the old version: rolled back by its version (kanban #546)
  const v2 = n.release('0.1.1', { signs: '0.1.1', answersAs: v1 });
  n.install(v1);
  const r = await n.update(v2);
  const db = readFileSync(join(n.home, 'node.db'), 'utf8');
  console.log(`  #1166 rolled back after the new release answered and signed: ${r.rolledBack ? 'rolled back' : 'not rolled back'}; node.db ${db.includes('nonce 7') ? 'keeps' : 'FORGOT'} the nonce it used`);
  assert.equal(r.rolledBack, true);
  assert.ok(db.includes('nonce 7 used by 0.1.1'), 'the nonce the new release used is not forgotten');
  assert.equal(n.running, v1);
  // a release that never answers: the database from before, and the WAL it left beside it dropped (it belongs to the newer file)
  const v3 = n.release('0.1.2', { broken: true, wal: true });
  const before = readFileSync(join(n.home, 'node.db'), 'utf8');
  const r3 = await n.update(v3);
  console.log(`  #1166 rolled back, never answered: node.db ${readFileSync(join(n.home, 'node.db'), 'utf8') === before ? 'as before' : 'changed'}; its WAL ${existsSync(join(n.home, 'node.db-wal')) ? 'LEFT beside the old database' : 'dropped'}`);
  assert.equal(r3.rolledBack, true);
  assert.equal(readFileSync(join(n.home, 'node.db'), 'utf8'), before);
  assert.ok(!existsSync(join(n.home, 'node.db-wal')), 'no WAL of the new release beside the old database');
  rmSync(n.root, { recursive: true, force: true });
});

test('an update lock left from before the machine started is no lock, even when its pid runs again', async () => {
  const h = mkdtempSync(join(tmpdir(), 'lock-1166-'));
  const bootNow = Math.round((Date.now() - uptime() * 1000) / 60000);
  writeFileSync(join(h, 'update.lock'), JSON.stringify({ pid: process.pid, atMs: Date.now() - 60000, boot: bootNow - 600 }));
  let r;
  try { r = await takeUpdateLock(h, { pid: 4242, waitLockMs: 100, sleep: fast }); } catch (e) { r = { why: e.message }; }
  console.log(`  #1166 a lock from before the reboot, its pid alive again: ${r.release ? 'taken over at once' : `waited: "${r.why}"`}`);
  assert.ok(r.release, r.why);
  r.release();
  rmSync(h, { recursive: true, force: true });
});

test('a release folder left half unpacked is unpacked again, never used as it is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unpack-1166-'));
  const home = join(root, 'home');
  const rel = join(home, 'releases', 'arena-node-0.1.0-linux-x64');
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'VERSION'), '0.1.0\n');
  writeFileSync(join(home, 'arena.conf'), 'port=8470\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ release: { path: rel } }));
  const bytes = Buffer.from('a release asset'.repeat(4));
  const name = assetNameFor('0.1.1', 'linux', 'x64');
  const base = 'https://testnet.bitcoinarena.io/release/u/f/v0.1.1/';
  const files = new Map([[`${name}.part00`, bytes], ['SHA256SUMS', Buffer.from('sums')], ['SHA256SUMS.sig', Buffer.from('sig')]]);
  const fetcher = async (url) => { const f = files.get(url.slice(base.length)); return f ? { status: 200, arrayBuffer: async () => f } : { status: 404, arrayBuffer: async () => Buffer.alloc(0) }; };
  const latest = async () => ({ newer: true, latest: { version: '0.1.1', assets: { [name]: createHash('sha256').update(bytes).digest('hex') }, download: { base, parts: { [name]: [`${name}.part00`] } } } });
  // a tar killed half way: the folder is there, its runtime is not
  const target = join(home, 'releases', 'bitcoin-arena-node-0.1.1-linux-x64');
  mkdirSync(join(target, 'packages'), { recursive: true });
  let unpacked = 0, appliedTo = null;
  const r = await checkOnce({ home, latest, fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: true }),
    unpack: (_a, dir) => { unpacked++; mkdirSync(join(dir, 'bitcoin-arena-node-0.1.1-linux-x64', 'runtime'), { recursive: true }); writeFileSync(join(dir, 'bitcoin-arena-node-0.1.1-linux-x64', 'runtime', 'node'), 'whole'); },
    apply: async (o) => { appliedTo = o.newRelease; return { ok: true }; } });
  const whole = existsSync(join(target, 'runtime', 'node'));
  console.log(`  #1166 a half unpacked release folder: unpacked ${unpacked} time(s); the node moved to a ${whole ? 'whole' : 'PARTIAL'} tree`);
  assert.equal(r.ok, true, r.why);
  assert.equal(appliedTo, target);
  assert.equal(unpacked, 1, 'unpacked again');
  assert.ok(whole, 'the tree the node moves to is whole');
  // and once whole (marked), the next check does not unpack it again
  rmSync(join(home, 'releases', 'downloads'), { recursive: true, force: true });
  unpacked = 0;
  await checkOnce({ home, latest, fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: true }), unpack: () => { unpacked++; }, apply: async () => ({ ok: true }) });
  assert.equal(unpacked, 0);
  rmSync(root, { recursive: true, force: true });
});
