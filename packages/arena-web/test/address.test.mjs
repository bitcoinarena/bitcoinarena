// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ADDRESS SCREEN IN REACT (kanban #564 / #563): where the node is reached, the warning for a quick tunnel, the switch with the
// token or hostname a mode needs, the progress read again until done, the Cloudflare login link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddressPanel, argsOf, running } from '../dist/test/address.mjs';

const MODES = { direct: 'own address', permanent: 'named tunnel', workers: 'workers.dev', tailscale: 'Funnel', quick: 'anonymous' };
const quick = { ok: true, mode: 'quick', url: 'https://cottage-usually-pete-path.trycloudflare.com', stable: false, modes: MODES, progress: null };
function driven(api) { const c = new AddressPanel({ api, pollMs: 10 }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); }; return c; }

test('what it shows: the address, the warning while it is a quick tunnel, the modes; a stable one no warning; the login link while waiting', () => {
  const html = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: quick, mode: 'quick' } }));
  assert.match(html, /<code class="addr-url">https:\/\/cottage-usually-pete-path/);
  assert.match(html, /<span class="pill wait">Changes at every restart<\/span>/);
  assert.match(html, /changes when the node restarts/);
  for (const m of Object.keys(MODES)) assert.match(html, new RegExp(`<input type="radio" name="reach-mode"[^>]*value="${m}"`), `a card for ${m}`);
  assert.match(html, /<label class="choice on now">/, 'the way in now is marked and chosen');
  const stable = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ...quick, mode: 'permanent', stable: true } } }));
  assert.doesNotMatch(stable, /changes when the node restarts/);
  const login = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ...quick, progress: { state: 'login', mode: 'permanent', loginUrl: 'https://dash.cloudflare.com/argotunnel?x=1' } } } }));
  assert.match(login, /href="https:\/\/dash\.cloudflare\.com\/argotunnel\?x=1"/);
  assert.doesNotMatch(login, /name="reach-mode"/, 'one switch at a time');
  const manual = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ok: false, why: 'this node was not installed by the Arena installer: its address is its operator\'s own' } } }));
  assert.match(manual, /set up by hand/);
});

test('what it does: the switch asked with the mode\'s token, the progress read until done', async () => {
  const asked = [];
  let progress = null;
  const api = { signed: async (a, args) => ({ args }), post: async (_p, b) => {
    if (b.args && b.args.mode) { asked.push(b.args); progress = { state: 'running', mode: b.args.mode }; return { ok: true }; }
    const r = { ...quick, progress }; if (progress && progress.state === 'running') progress = { state: 'done', mode: 'workers', url: 'https://arena-node-ab12.op.workers.dev' }; return r; } };
  const c = driven(api);
  await c.read();
  c.setState({ mode: 'workers', cfToken: ' tok ' });
  await c.go();
  assert.deepEqual(asked, [{ mode: 'workers', cfToken: 'tok', cfSubdomain: null }]);
  assert.equal(running(c.state.answer.progress), true, 'switching');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.state.answer.progress.state, 'done', 'read again until done');
  c.componentWillUnmount();
  assert.deepEqual(argsOf('permanent', { hostname: ' Node.example.com ' }), { mode: 'permanent', hostname: 'Node.example.com' });
});

// THE FIRST LOGIN (kanban #956: "after first log in, the public address block is always marked as error and only a page reload shows the
// correct info"): a read that fails is asked again while it is still reading, and the address shows without a reload; a node set up by hand
// is said at once, and a read that keeps failing says why after its tries
test('a failed first read is asked again: the address shows without a reload', async () => {
  let n = 0;
  const api = { signed: async () => ({}), post: async () => (++n === 1 ? { ok: false, why: 'this request is not signed by the owner' } : quick) };
  const c = new AddressPanel({ api, retryMs: 5 }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.read();
  assert.equal(c.state.loaded, false, 'still reading after the failed first read - no error shown');
  assert.match(renderToStaticMarkup(c.render()), /reading how this node is reached/);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 2);
  assert.equal(c.state.answer.ok, true);
  assert.match(renderToStaticMarkup(c.render()), /cottage-usually-pete-path/);
  clearTimeout(c.timer);
  // set up by hand: said at once, not asked again
  let m = 0;
  const hand = new AddressPanel({ api: { signed: async () => ({}), post: async () => { m++; return { ok: false, why: 'this node was not installed by the Arena installer' }; } }, retryMs: 5 });
  hand.setState = c.setState.bind(hand); hand.setState = (u) => { Object.assign(hand.state, typeof u === 'function' ? u(hand.state) : u); };
  await hand.read(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(m, 1); assert.match(renderToStaticMarkup(hand.render()), /set up by hand/);
  // always failing: the reason after its tries
  let k = 0;
  const bad = new AddressPanel({ api: { signed: async () => ({}), post: async () => { k++; return { ok: false, why: 'the node did not answer' }; } }, retryMs: 2, retries: 3 });
  bad.setState = (u) => { Object.assign(bad.state, typeof u === 'function' ? u(bad.state) : u); };
  await bad.read(); await new Promise((r) => setTimeout(r, 60));
  assert.equal(k, 3); assert.match(renderToStaticMarkup(bad.render()), /the node did not answer/);
});
