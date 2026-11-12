// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-5): AN UPDATE KEPT BY THE RESUME NEVER ADVERTISES THE NEW RELEASE'S APP VERSIONS.
// moveNode, once the new release answers as the same node with its version, ends the journal KEPT and then posts the advertisement update
// naming the release's app versions and protocols (change-roles.js refreshHostedGames, `refreshGames`): the census draws a node only for the
// games it names. An update whose updater DIED after the units were written (the machine restarted, the updater was killed) is finished by
// resumeUpdate - inside the next updateNode or at the auto-update service's start - and its KEPT path sets the release and ends the journal,
// but never refreshes the advertisement; the next check then finds the node on the newest release ("up to date" / "that release is the one
// running") and nothing ever posts it. The node runs the new release and stays advertised with the old app versions until a later release.
// Invariant: a release kept on this node is advertised with its app versions, whichever path kept it.
// Played on a Linux node with no process at all (the update-journal-1166 fixture, as wf1489-sm1-node-2): units, systemctl and the seat's
// answers are the test's; its temp folders stay in the OS temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, readJournal, releaseOfUnit } from '../src/update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const commitOf = (v) => createHash('sha1').update(v).digest('hex');
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-5-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const rels = new Map();
  const release = (v, behaves = {}) => {
    const dir = join(root, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${commitOf(v)}\n`);
    rels.set(dir, behaves);
    return dir;
  };
  const node = { root, home, env, port, units, release, running: null, hangStartOf: null, starts: [] };
  node.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    if (verb === 'stop' && names.includes(UNIT)) node.running = null;
    if (verb === 'start' && names.includes(UNIT)) {
      const rel = releaseOfUnit(readFileSync(join(units, UNIT), 'utf8'));
      node.starts.push(rel);
      if (node.hangStartOf === rel) return new Promise(() => {});   // the updater dies here
      node.running = rel;
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
  node.install = (v1) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), 'the database of the node\n');
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    node.running = v1;
  };
  node.opts = { home, port, env, sh: node.sh, fetcher: node.fetcher, platform: 'linux', nowMs: () => 0, sleep: fast, waitMs: 1500, fetchApps: async () => ({ ok: true }) };
  return node;
}

test('sm1-node-5 contrast: a move that is kept posts the games update of the new release once', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0'), v2 = n.release('0.1.1');
  n.install(v1);
  const refreshed = [];
  const r = await updateNode({ ...n.opts, newRelease: v2, refreshGames: async (o) => { refreshed.push(o.release); return { ok: true }; } });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(refreshed, [v2]);
});

test('sm1-node-5 an update the resume keeps (its updater died after writing the units) refreshes the advertisement\'s app versions as a kept move does', async () => {
  const n = linuxNode();
  const v1 = n.release('0.1.0'), v2 = n.release('0.1.1');
  n.install(v1);
  const refreshed = [];
  const refreshGames = async (o) => { refreshed.push(o.release); return { ok: true }; };
  // the auto updater moves the node to 0.1.1 and dies while 0.1.1 starts (after its units were written)
  n.hangStartOf = v2;
  updateNode({ ...n.opts, newRelease: v2, refreshGames }).catch(() => {});
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(readJournal(n.home).phase, 'units-written', 'the updater died with the new units written');
  writeFileSync(join(n.home, 'update.lock'), JSON.stringify({ pid: 999999, atMs: Date.now() }));   // its lock: a dead process's
  n.hangStartOf = null;
  // the next updateNode (the service's next check, or bitcoinarena update) finishes the journal: 0.1.1 answers as the same node - kept
  const r = await updateNode({ ...n.opts, newRelease: v2, refreshGames });
  console.log(`  sm1-node-5: ${r.ok ? 'ok' : r.why}; resumed ${r.resumed && r.resumed.resumed}; journal ${readJournal(n.home).phase}; running ${n.running === v2 ? '0.1.1' : 'other'}; games refreshed ${refreshed.length} time(s)`);
  assert.equal(r.ok, true);
  assert.equal(r.resumed && r.resumed.resumed, 'kept');
  assert.equal(readJournal(n.home).phase, 'kept');
  assert.equal(n.running, v2, 'the node runs 0.1.1');
  assert.deepEqual(refreshed, [v2], 'the kept release\'s app versions are advertised (refreshGames), as moveNode does after KEPT');
});
