// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-2): A ROLLBACK THE RESUME MADE IS NOT RECORDED, SO THE DAY'S WAIT (#1369) NEVER APPLIES.
// The auto updater records a rolled-back release in auto-update.json and tries it again only a day later (#1369, INSTALLER-DOORS-9); an
// update that threw is recorded too (#1440). An update whose updater DIED (the machine restarted, the updater was killed, the new release took
// the machine down while it loaded) is finished by resumeUpdate - at the service's start (runAutoUpdate -> resumeUnderLock) or inside the next
// updateNode - and that rollback writes no record. So the first check after the service's restart (10 min) stops the node, backs up its
// database (never pruned) and waits on the same broken release again; an updater that dies every time loops for good.
// Played on a Linux node with no process at all (the update-journal-1166 fixture): units, systemctl and the seat's answers are the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, resumeUpdate, releaseOfUnit } from '../src/update.js';
import { checkOnce, runAutoUpdate, assetNameFor } from '../src/auto-update.js';
import { seatUnit, UNIT } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
// a release's COMMIT and the commit latest.json names are the same git commit (build-release.sh and latest.mjs both take `git rev-parse`)
const commitOf = (v) => createHash('sha1').update(v).digest('hex');
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-2-'));
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
  node.opts = { home, port, env, sh: node.sh, fetcher: node.fetcher, platform: 'linux', nowMs: () => 0, sleep: fast, waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null };
  return node;
}
// release 0.1.1 as latest.json serves it (the auto-update test's fixture)
function served(bytes) {
  const name = assetNameFor('0.1.1', 'linux', 'x64');
  const files = new Map([[`${name}.part00`, bytes], ['SHA256SUMS', Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)], ['SHA256SUMS.sig', Buffer.from('sig')]]);
  const base = 'https://testnet.bitcoinarena.io/release/u/folder123/v0.1.1/';
  const fetcher = async (url) => { const f = files.get(url.slice(base.length)); return f ? { status: 200, arrayBuffer: async () => f } : { status: 404, arrayBuffer: async () => Buffer.alloc(0) }; };
  const latest = async (own) => ({ latest: { version: '0.1.1', commit: commitOf('0.1.1'), assets: { [name]: createHash('sha256').update(bytes).digest('hex') },
    download: { base, sums: 'SHA256SUMS', sig: 'SHA256SUMS.sig', parts: { [name]: [`${name}.part00`] } } }, newer: own !== '0.1.1' });
  return { name, fetcher, latest };
}

test('sm1-node-2 a release the resume rolled back (its updater died) is not tried again at the next check: the day\'s wait applies', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('0.1.0'), v2 = n.release('0.1.1', { broken: true });
    n.install(v1);
    // the auto updater moves the node to 0.1.1 and dies after writing its units (the machine restarted while 0.1.1 started)
    n.hangStartOf = v2;
    updateNode({ ...n.opts, newRelease: v2 }).catch(() => {});
    await new Promise((ok) => setTimeout(ok, 300));
    writeFileSync(join(n.home, 'update.lock'), JSON.stringify({ pid: 999999, atMs: Date.now() }));   // its lock: a dead process's
    n.hangStartOf = null;
    // the auto update service starts again: it finishes the open journal (rolled back: 0.1.1 does not answer), then checks after firstMs
    const s = served(Buffer.from('the release asset that does not come up on this machine'.repeat(3)));
    const applied = [], logs = [];
    let resumed = null;
    await runAutoUpdate({ home: n.home, latest: s.latest, log: (l) => logs.push(l), sleep: fast, exit: (c) => c, rounds: 1, firstMs: 10, interactive: async () => null,
      resume: async () => (resumed = await resumeUpdate({ ...n.opts, log: () => {} })),
      once: (o) => checkOnce({ ...o, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: true }),
        unpack: (archive, dir) => { mkdirSync(join(dir, 'bitcoin-arena-node-0.1.1-linux-x64'), { recursive: true }); },
        apply: async (a) => { applied.push(a.newRelease); return { ok: false, rolledBack: true, why: 'the new release did not come up' }; } }) });
    const rec = existsSync(join(n.home, 'auto-update.json')) ? JSON.parse(readFileSync(join(n.home, 'auto-update.json'), 'utf8')) : null;
    console.log(`  sm1-node-2: the resume at the service's start: ${resumed && resumed.resumed} (${resumed && resumed.why}); auto-update.json before the check: ${rec && rec.rolledBack && applied.length === 0 ? 'records it' : 'nothing'}; the first check then stopped the node for 0.1.1 again: ${applied.length} time(s)`);
    assert.equal(resumed && resumed.resumed, 'rolled-back', 'the service start rolled the broken release back');
    assert.equal(applied.length, 0, 'the release rolled back minutes ago is not tried again at the next check (#1369: a day later)');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('sm1-node-2 (#1581) inside updateNode: the auto updater does not move again to the release its own resume just rolled back; the rollback is recorded', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('0.1.0'), v2 = n.release('0.1.1', { broken: true });
    n.install(v1);
    n.hangStartOf = v2;
    updateNode({ ...n.opts, newRelease: v2 }).catch(() => {});
    await new Promise((ok) => setTimeout(ok, 300));
    writeFileSync(join(n.home, 'update.lock'), JSON.stringify({ pid: 999999, atMs: Date.now() }));
    n.hangStartOf = null;
    const startsBefore = n.starts.length;
    const r = await updateNode({ ...n.opts, newRelease: v2, retryRolledBack: false });
    const rec = JSON.parse(readFileSync(join(n.home, 'auto-update.json'), 'utf8'));
    const v2Starts = n.starts.slice(startsBefore).filter((s) => s === v2).length;
    console.log(`  sm1-node-2 updateNode: ${r.ok ? 'ok' : r.why}; 0.1.1 started ${v2Starts} time(s) in this call; record ${rec.to} rolledBack ${rec.rolledBack} resumed ${rec.resumed}`);
    assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
    assert.equal(r.resumed && r.resumed.resumed, 'rolled-back');
    assert.equal(v2Starts, 1, 'only the resume started 0.1.1 (to see whether it answers); no second move');
    assert.equal(rec.to, '0.1.1'); assert.equal(rec.rolledBack, true); assert.equal(rec.resumed, true);
    assert.equal(rec.commit, commitOf('0.1.1'));
    assert.equal(n.running, v1, 'the old release runs');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
