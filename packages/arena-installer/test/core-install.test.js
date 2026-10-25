// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN CORE INSTALLED BY THE WIZARD (ruling 8): the plan, a refusal when the disk is too small, the install with a service
// per network, the sync's progress with an ETA over a sliding window, and - once testnet4 is synced - the chain step saved by itself.
// Measured 2026-10-18 on the test host: Bitcoin Core 31.1 downloaded, checked (b80d9c3e...) and unpacked in 5.8 s; a fresh pruned
// testnet4 sync read every 10 s (7,184 blocks in 80 s); the 10 s ETA jumped 2,973 -> 109 min, hence the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizard } from '../src/wizard.js';
import { nodeState, ownCoreOf } from '../src/state.js';
import { syncStatus, diskCheck, NEEDS, ETA_MIN_SPAN_MS } from '../src/bitcoind.js';

function client(port) {
  let cookie = '';
  const req = (method, path, body) => new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-arena-wizard': '1' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { const sc = res.headers['set-cookie']; if (sc) cookie = String(sc[0]).split(';')[0]; let j = null; try { j = JSON.parse(b); } catch { /* */ } ok({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    r.on('error', no); if (body) r.write(JSON.stringify(body)); r.end();
  });
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), get cookie() { return cookie; }, set cookie(c) { cookie = c; } };
}

test('with no Electrum server reachable, the wizard installs Bitcoin Core, watches its sync, and saves the chain step once testnet4 is synced', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-core-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const GB = 2 ** 30;
  let free = 10 * GB, synced = false, progress = 0.1;
  const services = [];
  const coreKit = {
    detectBitcoind: async () => null,
    diskCheck: (dir) => diskCheck(dir, { statfs: () => ({ bavail: free / 4096, bsize: 4096 }) }),
    installCore: async () => ({ ok: true, bitcoind: join(home, 'bitcoin-core/bitcoin-31.1/bin/bitcoind') }),
    configureCore: ({ network, prune }) => ({ datadir: join(home, `bitcoin-${network}`), rpcUrl: 'http://127.0.0.1:48342/', cookiePath: join(home, 'c'), prune }),
    coreArgs: ({ bitcoind, datadir }) => [bitcoind, `-datadir=${datadir}`],
    installProgram: async (o) => { services.push(o); return { ok: true }; },
    syncStatus: async ({ samples }) => ({ ok: true, blocks: synced ? 156900 : 50000, headers: 156900, progress: synced ? 1 : progress, synced, etaMs: synced ? 0 : 3600000, samples }),
  };
  const tested = [];
  const w = createWizard({ state: nodeState(home), release: '/r', coreKit, test: async (c) => { tested.push(c); return c.kind === 'electrum' ? { ok: false, why: 'unreachable' } : { ok: true, why: 'fine', source: { latencyMs: 3, height: 156900 } }; } });
  const server = http.createServer((q, s) => w.handle(q, s)); await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const c = client(server.address().port);
  const enter = await c.get(`/?t=${w.token}`);
  assert.match(enter.headers['set-cookie'][0], /Max-Age=604800/, 'a week: the page can be bookmarked');

  const plan = (await c.post('/api/core/plan')).json;
  assert.equal(plan.installed, null);
  assert.match(plan.disk.warn, /not enough for both full nodes/);
  const small = (await c.post('/api/core/install', { prune: false })).json;
  assert.equal(small.ok, false); assert.match(small.why, /10 GB free, and testnet4 need about 25 GB/);
  const ok = (await c.post('/api/core/install', { prune: true })).json;
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual(services.map((x) => x.id), ['bitcoind-testnet4'], 'one service: testnet4');
  free = 2000 * GB;
  services.length = 0;

  let st = (await c.get('/api/core/status')).json;
  assert.equal(st.networks.testnet4.blocks, 50000);
  assert.equal(st.networks.chainSaved, undefined);
  assert.equal((await c.post('/api/start', { mode: 'new' })).json.ok, true);   // New / Restore first (kanban #652)
  assert.equal((await c.get('/api/state')).json.step, 'chain', 'still syncing: the chain step waits');
  synced = true;
  st = (await c.get('/api/core/status')).json;
  assert.equal(st.networks.chainSaved, true);
  assert.deepEqual(tested.filter((x) => x.kind === 'core')[0], { kind: 'core', url: 'http://127.0.0.1:48342/', cookiePath: join(home, 'c') }, 'tested like any Bitcoin Core');
  assert.equal((await c.get('/api/state')).json.step, 'roles', 'synced: the wizard goes on');

  // THE BOOKMARK AFTER AN INSTALLER RESTART: the same cookie opens a new wizard on the same home
  const w2 = createWizard({ state: nodeState(home), release: '/r', coreKit });
  const s2 = http.createServer((q, s) => w2.handle(q, s)); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const c2 = client(s2.address().port); c2.cookie = c.cookie;
  const again = await c2.get('/api/state');
  s2.close();
  assert.equal(again.status, 200, 'the bookmarked page opens again');
  assert.equal(readFileSync(join(home, 'sessions.json'), 'utf8').includes(c.cookie.split('=')[1]), false, 'the cookie itself is not on disk');
});

// KANBAN #635 (the owner 2026-10-25: "Wo BTC core installiert wird sollte auswählbar sein", "Auch der Bitcoin core nicht im Vordergrund machen
// lassen während der synced"): the blocks go to the owner's folder, and the wizard goes on at once with an Electrum server as the chain
// until the chain-switch keeper moves the node to its own Core
test('Bitcoin Core goes to the chosen folder and syncs in the background: the wizard goes on with an interim Electrum chain', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-core-bg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = [];
  const coreKit = {
    detectBitcoind: async () => null,
    diskCheck: (dir) => diskCheck(home, { statfs: () => ({ bavail: (2000 * 2 ** 30) / 4096, bsize: 4096 }) }),
    installCore: async () => ({ ok: true, bitcoind: '/b/bitcoind' }),
    configureCore: (o) => { configured.push(o); return { datadir: join(o.home, `bitcoin-${o.network}`), rpcUrl: 'http://127.0.0.1:48342/', cookiePath: join(o.home, 'c') }; },
    coreArgs: ({ bitcoind, datadir }) => [bitcoind, `-datadir=${datadir}`],
    installProgram: async () => ({ ok: true }),
    syncStatus: async ({ samples }) => ({ ok: true, blocks: 1, headers: 156900, progress: 0.001, synced: false, etaMs: null, samples }),
  };
  const tested = [];
  // the first server is down, the second answers
  const w = createWizard({ state: nodeState(home), release: '/r', coreKit, test: async (c) => { tested.push(c); return c.kind === 'electrum' && c.port === 40002 ? { ok: false, why: 'down' } : { ok: true, why: 'fine', source: { latencyMs: 9, height: 157544 } }; } });
  const server = http.createServer((q, s) => w.handle(q, s)); await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const c = client(server.address().port);
  await c.get(`/?t=${w.token}`);
  const rel = (await c.post('/api/core/plan', { dir: 'data/btc' })).json;
  assert.equal(rel.ok, false); assert.match(rel.why, /whole path/, 'a relative folder is refused');
  const plan = (await c.post('/api/core/plan', { dir: join(home, 'disk2') })).json;
  assert.equal(plan.dir, join(home, 'disk2'));
  const r = (await c.post('/api/core/install', { prune: true, dir: join(home, 'disk2') })).json;
  assert.equal(r.ok, true, r.why);
  assert.equal(configured[0].home, join(home, 'disk2'), 'the blocks go to the chosen folder');
  assert.deepEqual(r.interim, { host: 'seat.example.com', port: 443 }, 'the first server that passed: ours (kanban #656)');
  assert.deepEqual([tested.find((c) => c.host === 'seat.example.com').ws, tested.find((c) => c.host === 'seat.example.com').path], [true, '/electrum'], 'over its websocket');
  const st = (await c.get('/api/state')).json;
  assert.equal(st.step, 'roles', 'the wizard goes on while Core syncs');
  assert.equal(st.chain.kind, 'electrum');
  assert.deepEqual(st.coreSync, { dir: join(home, 'disk2'), interim: true, prune: true });
  // CUSTODY ON THE CORE INSTALLED HERE (the owner's playtest 2026-10-25: custody was refused right after "Install Bitcoin Core for me" -
  // "custody needs your own Bitcoin Core: LND cannot run on an Electrum server"): the interim chain is Electrum, the Core is this node's own
  const roles = (await c.post('/api/roles', { roles: ['verify', 'settlement', 'custody'] })).json;
  assert.equal(roles.ok, true, roles.why);
  assert.deepEqual(ownCoreOf(nodeState(home).read()), { kind: 'core', url: 'http://127.0.0.1:48342/', cookiePath: join(home, 'disk2', 'c') }, 'LND and the guardian read it');
  assert.equal(ownCoreOf({ chain: { kind: 'electrum', host: 'h', port: 1 } }), null, 'an Electrum node without a Core of its own has none');
});

test('the ETA is said only after a few minutes of readings, from the progress over the window', async () => {
  const fetcher = async (_u, init) => new Response(JSON.stringify({ result: { chain: 'testnet4', blocks: 10, headers: 100, verificationprogress: Number(JSON.parse(init.body).id === 'x' ? 0 : progressNow), initialblockdownload: true } }));
  let progressNow = 0.1;
  const home = mkdtempSync(join(tmpdir(), 'arena-eta-'));
  try {
    const cookiePath = join(home, 'cookie'); (await import('node:fs')).writeFileSync(cookiePath, 'u:p');
    const a = await syncStatus({ rpcUrl: 'http://x/', cookiePath, samples: [], nowMs: 0, fetcher });
    assert.equal(a.etaMs, null);
    progressNow = 0.2;
    const b = await syncStatus({ rpcUrl: 'http://x/', cookiePath, samples: a.samples, nowMs: ETA_MIN_SPAN_MS - 1, fetcher });
    assert.equal(b.etaMs, null, 'under two minutes of readings: no ETA yet');
    progressNow = 0.3;
    const c = await syncStatus({ rpcUrl: 'http://x/', cookiePath, samples: b.samples, nowMs: ETA_MIN_SPAN_MS * 2, fetcher });
    assert.equal(c.etaMs, Math.round(0.7 * (ETA_MIN_SPAN_MS * 2) / 0.2), '0.2 progress in 4 min: 0.7 left takes 14 min');
    assert.ok(NEEDS.mainnet.fullBytes > NEEDS.testnet4.fullBytes * 10);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// THE LINK OPENED AGAIN (kanban #635, the owner's playtest 2026-10-25: the test host app's "Open in browser" opened the used setup link and the
// page said "that setup link is used or expired" in the browser that was logged in already)
test('the used setup link in a browser that holds its session goes to the setup page; without the session it is still refused', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-link-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const w = createWizard({ state: nodeState(home), release: '/r' });
  const server = http.createServer((q, s) => w.handle(q, s)); await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const c = client(server.address().port);
  const token = w.token;
  assert.equal((await c.get(`/?t=${token}`)).status, 303, 'the first visit trades the link for a session');
  const again = await c.get(`/?t=${token}`);
  assert.deepEqual([again.status, again.headers.location], [303, '/'], 'the same browser, the link again: to the setup page');
  const stranger = client(server.address().port);
  assert.equal((await stranger.get(`/?t=${token}`)).status, 403, 'another browser with the used link: refused');
});

// A PORT ANOTHER PROGRAM HOLDS (kanban #635, the owner's playtest 2026-10-25: his test host's own testnet4 Core held 48342, the installer's Core
// exited 26 times - "Binding RPC on address 127.0.0.1 port 48342 failed" - and the page said "bitcoind is starting (no cookie yet)")
test('free ports are chosen, a Core whose port is taken says so, and the status moves it to free ports and starts it again', async (t) => {
  const { freeCorePorts, coreFailure } = await import('../src/bitcoind.js');
  const taken = new Set([48342]);
  assert.deepEqual(await freeCorePorts('testnet4', { free: async (p) => !taken.has(p) }), { rpc: 48352, p2p: 48353 }, 'the next free pair, 10 up');
  const log = '2026-10-25T11:00:00Z Bitcoin Core version v31.1\n2026-10-25T11:00:01Z [error] old\n2026-10-25T11:06:39Z Bitcoin Core version v31.1\n'
    + '2026-10-25T11:06:39Z [warning] Binding RPC on address 127.0.0.1 port 48342 failed.\n2026-10-25T11:06:39Z [error] Unable to bind any endpoint for RPC server\nError: Unable to start HTTP server. See debug log for details.\n';
  assert.deepEqual(coreFailure('/x/testnet4/.cookie', { read: () => log }), { why: 'Bitcoin Core stopped: another program uses its port', portTaken: true });
  assert.equal(coreFailure('/x/testnet4/.cookie', { read: () => 'Bitcoin Core version v31.1\nall fine\n' }), null);

  const home = mkdtempSync(join(tmpdir(), 'arena-port-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installed = [];
  let port = 48342;
  const coreKit = {
    detectBitcoind: async () => null, diskCheck: (dir) => diskCheck(home, { statfs: () => ({ bavail: (2000 * 2 ** 30) / 4096, bsize: 4096 }) }),
    installCore: async () => ({ ok: true, bitcoind: '/b/bitcoind' }),
    configureCore: (o) => ({ datadir: join(o.home, `bitcoin-${o.network}`), rpcUrl: `http://127.0.0.1:${(o.ports || { rpc: 48342 }).rpc}/`, cookiePath: join(o.home, 'c') }),
    coreArgs: ({ bitcoind, datadir }) => [bitcoind, `-datadir=${datadir}`], installProgram: async (o) => { installed.push(o.id); return { ok: true }; },
    freeCorePorts: async () => ({ rpc: port, p2p: port + 1 }),
    syncStatus: async ({ rpcUrl, samples }) => (rpcUrl.includes(':48342/') ? { ok: false, why: 'Bitcoin Core stopped: another program uses its port', portTaken: true, samples } : { ok: true, blocks: 1, headers: 9, progress: 0.1, synced: false, etaMs: null, samples }),
  };
  const st = nodeState(home);
  const w = createWizard({ state: st, release: '/r', coreKit, test: async () => ({ ok: false, why: 'no server' }) });
  assert.equal((await w['POST /api/core/install']({ prune: true })).ok, true);
  port = 48352;   // the Core's port taken after the install: the status finds it and moves it
  const s1 = await w['GET /api/core/status']();
  assert.match(s1.networks.testnet4.why, /another program uses its port: moved to port 48352 and started again/);
  assert.equal(st.read().core.networks.testnet4.rpcUrl, 'http://127.0.0.1:48352/', 'the new address kept');
  assert.deepEqual(installed, ['bitcoind-testnet4', 'bitcoind-testnet4'], 'its service written and started again');
  assert.equal((await w['GET /api/core/status']()).networks.testnet4.ok, true, 'then it answers');
});

// AT THE TIP IS SYNCED (kanban #636, the owner's playtest: "testnet4 pruned downloads to 100% and then nothing happens"): Core keeps
// initialblockdownload on while its tip is older than a day; all blocks in and 99.99 % verified count as synced
test('a Core at the tip counts as synced even while it still says initial block download', async () => {
  const { syncStatus } = await import('../src/bitcoind.js');
  const { mkdtempSync: mk, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mk(join(tmpdir(), 'sync-')); const cookiePath = join(dir, '.cookie'); wf(cookiePath, '__cookie__:x');
  const at = (info) => syncStatus({ rpcUrl: 'http://127.0.0.1:1/', cookiePath, fetcher: async () => new Response(JSON.stringify({ result: { chain: 'testnet4', ...info }, error: null, id: 1 }), { status: 200 }) });
  try {
    assert.equal((await at({ blocks: 157600, headers: 157600, verificationprogress: 0.99998, initialblockdownload: true })).synced, true, 'at the tip, IBD still on: synced');
    assert.equal((await at({ blocks: 157600, headers: 157600, verificationprogress: 1, initialblockdownload: false })).synced, true);
    assert.equal((await at({ blocks: 150000, headers: 157600, verificationprogress: 0.95, initialblockdownload: true })).synced, false, 'blocks still coming');
    assert.equal((await at({ blocks: 157600, headers: 157600, verificationprogress: 0.97, initialblockdownload: true })).synced, false, 'still verifying');
  } finally { rm(dir, { recursive: true, force: true }); }
});
