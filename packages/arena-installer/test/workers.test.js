// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// workers.dev (2026-10-18: "Implement workers dev tunnel"; "we are out of the game, don't host them"): the
// operator's own account and token, a Worker that forwards to the node's quick tunnel, re-uploaded by the keeper when the name changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workersSetup, deployForwarder, forwarderScript, createWorkersKeeper, workerNameOf } from '../src/workers.js';
import { servicesOf } from '../src/launchers.js';
import { nodeState } from '../src/state.js';

const TOKEN = 'x'.repeat(40);
const api = ({ subdomain = 'myname', accounts = [{ id: 'acc1' }] } = {}) => {
  const calls = [];
  const fetcher = async (url, o = {}) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    calls.push([o.method || 'GET', path, o.headers && o.headers.authorization, o.body]);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (o.headers.authorization !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }), { status: 403 });
    if (path === '/accounts') return ok(accounts);
    if (path === '/accounts/acc1/workers/subdomain' && (o.method || 'GET') === 'GET')
      return subdomain ? ok({ subdomain }) : new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: 'This account does not have a workers.dev subdomain' }] }), { status: 404 });
    if (path === '/accounts/acc1/workers/subdomain' && o.method === 'PUT') return ok({ subdomain: JSON.parse(o.body).subdomain });
    if (/\/workers\/scripts\/[a-z0-9-]+$/.test(path) && o.method === 'PUT') return ok({ id: path.split('/').pop() });
    if (/\/workers\/scripts\/[a-z0-9-]+\/subdomain$/.test(path) && o.method === 'POST') return ok(null);
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls };
};

test('setup: the token\'s account and its workers.dev name (made when there is none); a wrong token is said', async () => {
  let a = api();
  let r = await workersSetup({ token: TOKEN, name: workerNameOf('1a2b3c'), fetcher: a.fetcher });
  assert.deepEqual([r.ok, r.accountId, r.url], [true, 'acc1', 'https://arena-node-1a2b3c.myname.workers.dev']);
  a = api({ subdomain: null });
  r = await workersSetup({ token: TOKEN, name: 'arena-node-1a2b3c', wantSubdomain: 'satoshi-node', fetcher: a.fetcher });
  assert.equal(r.url, 'https://arena-node-1a2b3c.satoshi-node.workers.dev', 'no subdomain yet: one is made');
  assert.ok(a.calls.some(([m, p]) => m === 'PUT' && p.endsWith('/workers/subdomain')));
  assert.match((await workersSetup({ token: 'y'.repeat(40), name: 'n', fetcher: api().fetcher })).why, /not accepted: Invalid API Token/);
  assert.match((await workersSetup({ token: 'short', name: 'n', fetcher: api().fetcher })).why, /Edit Cloudflare Workers/);
  assert.match((await workersSetup({ token: TOKEN, name: 'n', fetcher: api({ accounts: [] }).fetcher })).why, /reaches no account/);
});

test('deploy: the script uploaded as a module and served on workers.dev; only a quick tunnel is a target', async () => {
  const a = api();
  const d = await deployForwarder({ token: TOKEN, accountId: 'acc1', name: 'arena-node-1a2b3c', target: 'https://ab-cd.trycloudflare.com', fetcher: a.fetcher });
  assert.equal(d.ok, true, d.why);
  const put = a.calls.find(([m]) => m === 'PUT');
  assert.equal(put[1], '/accounts/acc1/workers/scripts/arena-node-1a2b3c');
  assert.equal(JSON.parse(await put[3].get('metadata').text()).main_module, 'worker.js');
  assert.match(await put[3].get('worker.js').text(), /const TARGET = "https:\/\/ab-cd\.trycloudflare\.com"/);
  assert.ok(a.calls.some(([m, p, , b]) => m === 'POST' && p.endsWith('/subdomain') && JSON.parse(b).enabled === true));
  assert.match((await deployForwarder({ token: TOKEN, accountId: 'acc1', name: 'n', target: 'https://evil.example.com', fetcher: a.fetcher })).why, /only to a quick tunnel/);
});

test('the Worker forwards path and query to the tunnel and turns its redirects back into its own name', async (t) => {
  const mod = await import(`data:text/javascript,${encodeURIComponent(forwarderScript('https://ab-cd.trycloudflare.com'))}`);
  const seen = []; const real = globalThis.fetch;
  globalThis.fetch = async (req) => { seen.push(req.url); return req.url.includes('/go') ? new Response(null, { status: 302, headers: { location: 'https://ab-cd.trycloudflare.com/Dashboard/owner' } }) : new Response('id'); };
  t.after(() => { globalThis.fetch = real; });
  assert.equal(await (await mod.default.fetch(new Request('https://arena-node-1.myname.workers.dev/identity?a=1'))).text(), 'id');
  assert.equal(seen[0], 'https://ab-cd.trycloudflare.com/identity?a=1');
  assert.equal((await mod.default.fetch(new Request('https://arena-node-1.myname.workers.dev/go'))).headers.get('location'), 'https://arena-node-1.myname.workers.dev/Dashboard/owner');
});

test('the keeper re-points the Worker only when the tunnel\'s name changed', async () => {
  const state = nodeState(mkdtempSync(join(tmpdir(), 'workers-')));
  state.writeSecret('cf-workers-token', TOKEN);
  state.save({ reach: { mode: 'workers', url: 'https://arena-node-1a2b3c.myname.workers.dev', workerName: 'arena-node-1a2b3c', accountId: 'acc1', target: 'https://old-one.trycloudflare.com' } });
  let name = 'https://old-one.trycloudflare.com'; const deployed = [];
  const k = createWorkersKeeper({ state, tunnelUrl: async () => name, deploy: async (o) => { deployed.push(o.target); return { ok: true }; } });
  assert.match((await k.tick()).idle, /forwarding to https:\/\/old-one/);
  name = 'https://new-one.trycloudflare.com';
  assert.equal((await k.tick()).did, 'forward');
  assert.deepEqual([deployed, state.read().reach.target], [['https://new-one.trycloudflare.com'], 'https://new-one.trycloudflare.com']);
  assert.match((await k.tick()).idle, /new-one/, 'once');
  assert.deepEqual(servicesOf(state.read()).linux, ['arena-workers.service', 'arena-node.service', 'arena-tunnel.service'], 'the keeper and the quick tunnel are the node\'s services');
});

test('the wizard: workers.dev saved with the operator\'s token (kept 0600, never shown), the name fixed once', async (t) => {
  const http = await import('node:http');
  const { statSync, readFileSync } = await import('node:fs');
  const { createWizard } = await import('../src/wizard.js');
  const home = mkdtempSync(join(tmpdir(), 'workers-w-'));
  const state = nodeState(home);
  state.save({ chain: { kind: 'core', url: 'http://x/' }, roles: ['verify'], owner: { pubkey: 'ab'.repeat(32) }, done: { chain: 1, roles: 1, seed: 1, owner: 1 } });
  const a = api();
  const w = createWizard({ state, release: home, seatPort: 8470, fetcher: a.fetcher, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const port = server.address().port; let cookie = '';
  const go = (method, path, body) => new Promise((ok) => { const q = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
    if (r.headers['set-cookie']) cookie = r.headers['set-cookie'][0].split(';')[0]; let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } }); }); if (body) q.write(JSON.stringify(body)); q.end(); });
  await go('GET', `/?t=${w.token}`);
  assert.match((await go('POST', '/api/reach/save', { mode: 'workers', cfToken: 'y'.repeat(40) })).why, /not accepted/);
  const r = await go('POST', '/api/reach/save', { mode: 'workers', cfToken: TOKEN });
  assert.equal(r.ok, true, r.why);
  assert.match(r.reach.url, /^https:\/\/arena-node-[0-9a-f]{6}\.myname\.workers\.dev$/);
  assert.equal(statSync(join(home, 'cf-workers-token')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, 'cf-workers-token'), 'utf8'), TOKEN);
  assert.ok(!JSON.stringify(await go('GET', '/api/state')).includes(TOKEN), 'the page is never told the token');
  const again = await go('POST', '/api/reach/save', { mode: 'workers', cfToken: TOKEN });
  assert.equal(again.reach.url, r.reach.url, 'saved again: the same name');
});
