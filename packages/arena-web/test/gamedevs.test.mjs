// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME DEVELOPERS UNDER DONATIONS (kanban #582, 2026-10-22): shown only when a game developer's key is installed on the node - per
// app the split in force, Change split (signed by the node with that key), the past splits and the donations; installing a key folded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameDevsPanel } from '../dist/test/gamedevs.mjs';

const KA = '02' + 'aa'.repeat(32), KB = '03' + 'bb'.repeat(32), DEV = '5b8dee95235997d2'.padEnd(64, '0');
const split = [{ key: KA, label: 'dev a', shareBps: 6667 }, { key: KB, label: 'dev b', shareBps: 3333 }];
const devs = [{ devKey: DEV, apps: [{ name: 'nextblock', title: 'Tick Tock, Next Block', id: 'n5'.repeat(32), version: 5, split,
  versions: [{ version: 5, id: 'n5'.repeat(32), split }, { version: 4, id: 'n4'.repeat(32), split: [{ key: KA, label: 'dev a', shareBps: 10000 }] }],
  donations: { count: 51, appMsat: '141987000', byClient: [{ slug: 'dev-a', label: 'dev a', count: 51, appMsat: '94658000' }, { slug: 'dev-b', label: 'dev b', count: 51, appMsat: '47329000' }] } }] }];
const panel = (props = {}) => { const calls = { split: [], key: [], reread: 0 };
  const m = new GameDevsPanel({ devs, reread: () => { calls.reread++; }, changeSplit: async (g, r) => { calls.split.push([g, r]); return { version: 6 }; },
    addKey: async (k) => { calls.key.push(k); return { pubkey: DEV, apps: ['Tick Tock, Next Block'] }; }, removeKey: async () => ({}), ...props });
  m.setState = function (c) { this.state = { ...this.state, ...c }; };
  return { m, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) }; };

test('no game developer key on the node: no overview - only the folded form to install one', () => {
  const h = panel({ devs: [] }).html();
  assert.doesNotMatch(h, /Game developers|Change split/);
  assert.match(h, /<details><summary class="sub">Add a game developer key<\/summary>/);
});

test('a key installed: the app it signs - donations, the app\'s part, the split in force, Change split, the past splits', async () => {
  const p = panel();
  let h = p.html();
  assert.match(h, /<h3 class="sh">Game developers<\/h3><p class="sub gd-key">Developer key <span title="5b8dee9523599[0-9a-f]+">5b8dee95235997d2…<\/span> · signs Tick Tock, Next Block/);
  assert.match(h, /<div><span>Donations<\/span><b>51<\/b><\/div><div><span>The app&#x27;s part<\/span><b>141,987 sat<\/b><\/div><div><span>Versions<\/span><b>2<\/b><\/div>/);
  assert.match(h, /<h4>In force: version 5<\/h4>.*dev a <b>66.67 %<\/b>.*<button type="button" class="mini">Change split<\/button>/);
  assert.match(h, /<summary>Past splits · 1<\/summary><div class="row"><span>version 4 <span class="sub">n4n4n4n4n4n4<\/span><\/span><b>dev a 100 %<\/b><\/div>/);
  p.m.state.edit = { [devs[0].apps[0].id]: [{ key: KA, label: 'dev a', share: '50' }, { key: KB, label: 'dev b', share: '50' }] };
  h = p.html();
  assert.match(h, /<button type="button" class="primary">Sign version 6<\/button>/);
  await p.m.sign(devs[0].apps[0]);
  assert.deepEqual(p.calls.split, [['n5'.repeat(32), [{ key: KA, label: 'dev a', shareBps: 5000 }, { key: KB, label: 'dev b', shareBps: 5000 }]]]);
  assert.match(p.html(), /<p class="ok">Signed ✓ version 6 runs here now/);
  assert.equal(p.calls.reread, 1);
});

test('installing a key: the text handed over as it is, the answer names the apps it signs', async () => {
  const p = panel({ devs: [] });
  p.m.state.key = ' -----BEGIN PRIVATE KEY-----\nMC4CAQ...\n-----END PRIVATE KEY----- ';
  await p.m.install();
  assert.deepEqual(p.calls.key, ['-----BEGIN PRIVATE KEY-----\nMC4CAQ...\n-----END PRIVATE KEY-----']);
  assert.match(p.html(), /Installed ✓ developer 5b8dee95235997d2… · signs Tick Tock, Next Block/);
});
