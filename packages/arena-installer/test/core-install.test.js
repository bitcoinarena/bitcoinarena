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
import { nodeState } from '../src/state.js';
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
  assert.deepEqual(r.interim, { host: 'blackie.c3-soft.com', port: 57010 }, 'the first server that passed');
  const st = (await c.get('/api/state')).json;
  assert.equal(st.step, 'roles', 'the wizard goes on while Core syncs');
  assert.equal(st.chain.kind, 'electrum');
  assert.deepEqual(st.coreSync, { dir: join(home, 'disk2'), interim: true, prune: true });
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
