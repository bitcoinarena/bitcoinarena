// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S ADDRESS CARD (kanban #563 / #562 2C): how the node is reached, a warning while the address changes at every
// restart, the ways to switch, and the switch's progress - the Cloudflare login link while it waits for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('async function addressPanel() {');
const body = HTML.slice(a, HTML.indexOf('\n}\n', a) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const MODES = { direct: 'own address', permanent: 'named tunnel', workers: 'workers.dev', tailscale: 'Funnel', quick: 'anonymous' };

async function render(answer) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || { innerHTML: '', value: 'quick', disabled: false });
  const sent = [];
  const post = async (_p, b) => { sent.push(b); return answer; };
  const fn = new Function('$', 'post', 'signed', 'esc', 'setTimeout', `${body}; return addressPanel;`)($, post, async (act, args) => ({ act, args }), esc, () => {});
  await fn();
  return { html: els.address.innerHTML, els, sent };
}

test('a quick tunnel: the address, a warning that it changes at every restart, and the ways to switch', async () => {
  const { html } = await render({ ok: true, mode: 'quick', url: 'https://cottage-usually-pete-path.trycloudflare.com', stable: false, modes: MODES, progress: null });
  assert.match(html, /Reached at<\/span><b>https:\/\/cottage-usually-pete-path\.trycloudflare\.com/);
  assert.match(html, /changes when the node restarts/);
  for (const m of Object.keys(MODES)) assert.match(html, new RegExp(`<option value="${m}"`));
  assert.match(html, /<button id="rc-go"/);
});

test('a stable address: no warning; a switch waiting for the Cloudflare login shows its link and no new switch', async () => {
  const stable = await render({ ok: true, mode: 'permanent', url: 'https://node.example.com', stable: true, modes: MODES, progress: null });
  assert.doesNotMatch(stable.html, /changes when the node restarts/);
  const login = await render({ ok: true, mode: 'quick', url: 'https://x.trycloudflare.com', stable: false, modes: MODES,
    progress: { state: 'login', mode: 'permanent', loginUrl: 'https://dash.cloudflare.com/argotunnel?callback=abc' } });
  assert.match(login.html, /href="https:\/\/dash\.cloudflare\.com\/argotunnel\?callback=abc"/);
  assert.doesNotMatch(login.html, /rc-go/, 'one switch at a time');
  const done = await render({ ok: true, mode: 'workers', url: 'https://arena-node-ab12.op.workers.dev', stable: true, modes: MODES,
    progress: { state: 'done', mode: 'workers', url: 'https://arena-node-ab12.op.workers.dev' } });
  assert.match(done.html, /Switched to workers: https:\/\/arena-node-ab12\.op\.workers\.dev/);
});

test('a node set up by hand: its address is set on its machine', async () => {
  const { html } = await render({ ok: false, why: 'this node was not installed by the Arena installer: its address is its operator\'s own' });
  assert.match(html, /set up by hand/);
});
