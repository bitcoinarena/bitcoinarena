// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS ON THIS NODE IN REACT (kanban #564): each app once at its newest version, the older ones folded, the signed description,
// Remove for an installed one, and the update settings saved with the owner's signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppsPanel, newestApps } from '../dist/test/apps.mjs';

const hosted = [
  { id: 'aa', name: 'btc-updown', title: 'Up/Down', version: 14, installed: true },
  { id: 'bb', name: 'btc-updown', title: 'Up/Down', version: 15, installed: true, info: { description: 'Will BTC be up in 15 min?', website: 'https://arena.example' } },
  { id: 'cc', name: 'nextblock', title: 'Next Block', version: 3, installed: false },
];

test('each app once at its newest version, older ones folded, the signed description, Remove only for installed apps', () => {
  const apps = newestApps(hosted);
  assert.deepEqual(apps.map((a) => [a.id, a.older.map((o) => o.id)]), [['bb', ['aa']], ['cc', []]]);
  const html = renderToStaticMarkup(React.createElement(AppsPanel, { initial: { loaded: true, mine: { hosted, settings: { autoUpdate: true, sources: ['https://n1.example'] } }, auto: true, sources: 'https://n1.example' } }));
  // a card per app (kanban #565): its initial, its name, its version as a pill
  assert.match(html, /<span class="app-ic" aria-hidden="true">U<\/span><b class="app-name">Up\/Down<\/b><span class="pill">v15<\/span>/);
  assert.match(html, /1 older version kept for rounds that still use it/);
  assert.match(html, /Will BTC be up in 15 min\?/); assert.match(html, /href="https:\/\/arena\.example"/);
  assert.match(html, /<b class="app-name">Next Block<\/b><span class="pill">v3<\/span>[\s\S]*?built into this node<\/span><span class="pill on">built in<\/span>/);
  assert.equal((html.match(/class="app-card"/g) || []).length, 2, 'each app once');
  assert.match(html, /type="checkbox"[^>]*checked=""/);
});

test('Remove and Save signed and sent; the list read again after a removal; a seat still starting keeps empty lists', async () => {
  const sent = []; let list = hosted;
  const api = { get: async () => ({ hosted: list, settings: { autoUpdate: false, sources: [] } }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { sent.push([p, b.a, b.args]); if (p === '/owner/plugins/remove') list = list.filter((g) => g.id !== b.args.game); return { ok: true }; } };
  const c = new AppsPanel({ api }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.reload();
  await c.remove('aa');
  assert.deepEqual(sent[0], ['/owner/plugins/remove', 'remove', { game: 'aa' }]);
  assert.equal(c.state.mine.hosted.length, 2, 'read again');
  c.setState({ auto: true, sources: 'https://n1.example\n https://n2.example ' });
  await c.save();
  assert.deepEqual(sent[1], ['/owner/settings', 'settings', { autoUpdate: true, sources: ['https://n1.example', 'https://n2.example'] }]);
  assert.equal(c.state.saved, true);
  const empty = new AppsPanel({ api: { get: async () => ({}) } }); empty.setState = c.setState.bind(c); empty.setState = (u) => { Object.assign(empty.state, typeof u === 'function' ? u(empty.state) : u); };
  await empty.reload(); assert.deepEqual([empty.state.mine.hosted, empty.state.mine.settings.autoUpdate], [[], false]);
});
