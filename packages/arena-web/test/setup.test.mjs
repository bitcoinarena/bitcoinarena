// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S SETUP STEPS IN REACT (kanban #564, installer slice 2): the Bitcoin connection (Core, Electrum, Core installed here and
// its sync watched until the chain is saved), the reach (the direct test picking the default, the Cloudflare login waited for, each way's
// fields), the install (and the Nostr login after it) and the federation - against the installer's doors, their classes driven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChainStep, ReachStep, ServiceStep, FederationStep, chainText, defaultMode, dur } from '../dist/test/setup.mjs';

function driven(Step, props) {
  const c = new Step(props);
  c.setState = (u, after) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); if (after) after(); };
  return c;
}
const electrum = [{ host: 'e1.example', port: 50002, tls: true, note: 'one' }, { host: 'e2.example', port: 50001, tls: false, note: 'two' }];
const tick = () => new Promise((ok) => setTimeout(ok, 5));

test('chain: Core by cookie or by user and password, Electrum from the list, the test said in words, Save moves on', async () => {
  const posts = []; let reloaded = 0;
  const answers = { '/api/chain/test': { ok: true, result: { ok: true, why: 'both agree', source: { ok: true, height: 157193, latencyMs: 4, software: 'Satoshi:29.0.0' }, second: { endpoint: 'e1', ok: true, height: 157193, latencyMs: 80 } } },
    '/api/chain/save': { ok: true } };
  const c = driven(ChainStep, { st: { electrum }, post: async (p, b) => { posts.push([p, b]); return answers[p]; }, reload: () => { reloaded++; } });
  c.setState({ cookie: ' ~/.bitcoin/testnet4/.cookie ' });
  assert.deepEqual(c.body(), { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: '~/.bitcoin/testnet4/.cookie' });
  c.setState({ cookie: '', user: 'u', pass: 'p' });
  assert.deepEqual(c.body(), { kind: 'core', url: 'http://127.0.0.1:48332/', user: 'u', password: 'p' });
  await c.test();
  assert.equal(c.state.msg.text, 'Passed: both agree\nthis source: testnet4 (genesis checked), tip 157193, 4 ms, Satoshi:29.0.0\nsecond source e1: tip 157193, 80 ms');
  await c.kind('electrum'); c.pickServer('1');
  assert.deepEqual(c.body(), { kind: 'electrum', host: 'e2.example', port: 50001, tls: false });
  assert.match(renderToStaticMarkup(c.render()), /<option value="1" selected="">e2\.example:50001 - two<\/option><option value="own">another server<\/option>/);
  await c.save();
  assert.deepEqual(posts.at(-1), ['/api/chain/save', { kind: 'electrum', host: 'e2.example', port: 50001, tls: false }]); assert.equal(reloaded, 1);
  const bad = driven(ChainStep, { st: { electrum }, post: async () => ({ ok: false, result: { ok: false, why: 'another chain', source: { ok: false, why: 'genesis differs' } } }), reload() {} });
  await bad.save();
  assert.deepEqual(bad.state.msg, { ok: false, text: 'Failed: another chain\nthis source: genesis differs' });
});

test('chain: Core installed here - the disk said, pruned ticked when the full chain does not fit, the sync watched until the chain is saved', async () => {
  const plan = { disk: { freeBytes: 20 * 2 ** 30, warn: 'Not enough for a full testnet4 node: pruned is ticked.', networks: { testnet4: { full: false } } },
    needs: { testnet4: { fullBytes: 25 * 2 ** 30, prunedBytes: 6 * 2 ** 30 }, mainnet: { fullBytes: 800 * 2 ** 30, prunedBytes: 10 * 2 ** 30 } } };
  const posts = []; let reloaded = 0; let status = 0;
  const syncing = { ok: true, networks: { testnet4: { ok: true, blocks: 90000, headers: 157193, progress: 0.4, synced: false, etaMs: 7200000 } } };
  const c = driven(ChainStep, { st: { electrum }, pollMs: 1,
    post: async (p, b) => { posts.push([p, b]); return p === '/api/core/plan' ? plan : { ok: true }; },
    get: async () => (++status < 2 ? syncing : { ...syncing, chainSaved: true }), reload: () => { reloaded++; } });
  await c.kind('install');
  assert.equal(c.state.prune, true);
  let html = renderToStaticMarkup(c.render());
  assert.match(html, /Free on this disk: <b>20 GB<\/b>\. Needed: testnet4 25 GB \(pruned 6 GB\), mainnet 800 GB \(pruned 10 GB\)\./);
  assert.match(html, /Not enough for a full testnet4 node/);
  await c.install();
  assert.deepEqual(posts.at(-1), ['/api/core/install', { prune: true, mainnet: false }]);
  html = renderToStaticMarkup(c.render());
  assert.match(html, /<b>testnet4<\/b> - block 90,000 of 157,193 · 40\.00 % · about 2 h left/);
  assert.match(html, /<b>Bookmark this page\.<\/b>/);
  for (let i = 0; i < 20 && !reloaded; i++) await tick();
  assert.equal(reloaded, 1, 'the chain saved by the installer once synced: the wizard moves on');
  c.componentWillUnmount();
  assert.equal(dur(null), 'estimating… (a few minutes of syncing first)'); assert.equal(dur(3 * 86400000), 'about 3 days');
});

test('reach: the direct test picks the default, Cloudflare\'s login waited for, the chosen way posted with its fields', async () => {
  assert.equal(defaultMode(null), null); assert.equal(defaultMode({ reached: true }), 'direct'); assert.equal(defaultMode({ reached: false }), 'permanent');
  const posts = []; let reloaded = 0; let polls = 0;
  const answers = { '/api/reach/direct': { ok: true, result: { reached: false, address: '203.0.113.5', port: 9090, diagnosis: { advice: 'behind NAT: forward port 9090' } } },
    '/api/reach/login': { ok: true, url: 'https://dash.cloudflare.com/argotunnel?x=1' }, '/api/reach/save': { ok: true } };
  const c = driven(ReachStep, { st: { defaultPort: 9090 }, pollMs: 1, post: async (p, b) => { posts.push([p, b]); return answers[p]; },
    get: async () => (++polls < 2 ? { login: { url: 'https://dash.cloudflare.com/argotunnel?x=1', result: null } } : { login: { url: 'x', result: { ok: true } } }), reload: () => { reloaded++; } });
  assert.equal(c.state.mode, null);
  await c.save();
  assert.equal(c.state.msg.text, 'test the direct connection first, or choose a tunnel'); assert.equal(posts.length, 0);
  await c.test();
  assert.deepEqual(posts[0], ['/api/reach/direct', { port: 9090 }]);
  assert.equal(c.state.mode, 'permanent');
  let html = renderToStaticMarkup(c.render());
  assert.match(html, /Not reachable from outside: behind NAT: forward port 9090\nThe permanent tunnel is the default\./);
  assert.match(html, /<b>Permanent Cloudflare tunnel<\/b><span class="tag">recommended<\/span>/);
  await c.login();
  assert.match(renderToStaticMarkup(c.render()), /Open <a href="https:\/\/dash\.cloudflare\.com\/argotunnel\?x=1"/);
  for (let i = 0; i < 20 && !(c.state.login.result); i++) await tick();
  assert.match(renderToStaticMarkup(c.render()), /Logged in to Cloudflare\./);
  c.setState({ host: 'node.example.com' });
  await c.save();
  assert.deepEqual(posts.at(-1), ['/api/reach/save', { mode: 'permanent', hostname: 'node.example.com', port: 9090, cfToken: '' }]); assert.equal(reloaded, 1);
  c.setState({ mode: 'workers' });
  html = renderToStaticMarkup(c.render());
  assert.match(html, /id="r-cftoken"/); assert.doesNotMatch(html, /id="r-host"/, 'each way shows only its own fields');
  c.componentWillUnmount();
});

test('install: the user service started (after a reboot too by default); a Nostr owner logs in once after it', async () => {
  const posts = []; let reloaded = 0;
  const c = driven(ServiceStep, { post: async (p, b) => { posts.push([p, b]); return p === '/api/service' ? { ok: true, ms: 840, template: { kind: 27235, content: 'login', tags: [] } } : { ok: true }; },
    reload: () => { reloaded++; }, nostr: { signEvent: async (t) => ({ ...t, sig: 'ab' }) } });
  assert.match(renderToStaticMarkup(c.render()), /<input type="checkbox" id="boot" checked=""\/>/);
  await c.start();
  assert.deepEqual(posts[0], ['/api/service', { boot: true }]);
  const after = renderToStaticMarkup(c.render());
  assert.match(after, /<button type="button">Log in with Nostr<\/button>/); assert.doesNotMatch(after, /id="svc"/, 'the install button gives way to the login');
  assert.match(after, /The node runs \(started in 840 ms\)\. Now log in once with your Nostr key\./);
  await c.nostrLogin();
  assert.equal(posts[1][0], '/api/owner/login'); assert.equal(posts[1][1].nostr.sig, 'ab'); assert.equal(typeof posts[1][1].nostr.created_at, 'number');
  assert.equal(reloaded, 1);
  const s = driven(ServiceStep, { post: async () => ({ ok: false, why: 'the seat did not answer at its public address' }), reload() {} });
  await s.start();
  assert.match(renderToStaticMarkup(s.render()), /class="msg bad"[^>]*>the seat did not answer at its public address/);
});

test('federation: ten guardians, seven lit; Continue posts and moves on', async () => {
  const posts = []; let reloaded = 0;
  const c = driven(FederationStep, { post: async (p) => { posts.push(p); return { ok: true }; }, reload: () => { reloaded++; } });
  const html = renderToStaticMarkup(c.render());
  assert.equal((html.match(/<circle[^>]*r="11" fill="#f7931a"/g) || []).length, 7);
  assert.equal((html.match(/<circle[^>]*r="11" fill="#57606a"/g) || []).length, 3);
  assert.match(html, /Moving any of it takes <b>7 of the 10<\/b>/);
  await c.go();
  assert.deepEqual(posts, ['/api/federation']); assert.equal(reloaded, 1);
  assert.equal(chainText({ ok: false, why: 'x', source: { ok: false, why: 'y' } }), 'Failed: x\nthis source: y');
});
