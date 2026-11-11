// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DOWNLOADED ARCHIVES ARE PRUNED (kanban #1444, audit 8 O8-5): every auto update left its archive, about 200 MB, in
// <home>/releases/downloads/<version>/ for good - #576 pruned the release folders only. After an update is kept, only the downloads of the new
// release and the one it came from stay; an update rolled back removes nothing. A Linux node played with no process, as in #1166.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit } from '../src/update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

/** A Linux node in a temp home, its units in a temp systemd folder; `sh` plays systemctl, `fetcher` plays the seat that runs. */
function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'update-1444-'));
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
/** The archives earlier auto updates left: one folder per version, an archive in each. */
function downloadsOf(n, versions) {
  const dir = join(n.home, 'releases', 'downloads');
  for (const v of versions) { mkdirSync(join(dir, v), { recursive: true }); writeFileSync(join(dir, v, `bitcoin-arena-node-${v}-linux-x64.tar.gz`), `archive ${v}`); }
  return () => readdirSync(dir).sort();
}

test('#1444 a kept update removes the downloads of every release but the new one and the one it came from', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27');
    n.install(v1);
    const left = downloadsOf(n, ['2026.1.9.24', '2026.1.9.25', '2026.1.9.26', '2026.1.9.27']);
    const r = await n.update(v2);
    assert.equal(r.ok, true, r.why);
    assert.equal(n.running, v2);
    assert.deepEqual(left(), ['2026.1.9.26', '2026.1.9.27']);
    assert.deepEqual(r.prunedDownloads.sort(), ['2026.1.9.24', '2026.1.9.25']);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#1444 an update rolled back removes no download', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.26'), v2 = n.release('2026.1.9.27', { broken: true });
    n.install(v1);
    const left = downloadsOf(n, ['2026.1.9.24', '2026.1.9.25', '2026.1.9.26', '2026.1.9.27']);
    const r = await n.update(v2);
    assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
    assert.equal(n.running, v1);
    assert.deepEqual(left(), ['2026.1.9.24', '2026.1.9.25', '2026.1.9.26', '2026.1.9.27']);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
