// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REFERRER SECTION (kanban #675, 2026-10-25: "a section in the node called Referrer where he can select a name for his program. He can have
// multiple ones and each earns the fees ... The user must be able to withdraw his funds via lightning").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferrerPanel } from '../dist/test/referrer.mjs';

const KEY = '02' + 'ab'.repeat(32);
const P = { slug: 'demo-rps', label: 'Demo RPS', kind: 'referrer', recipientPk: KEY, running: true, referral: { msat: '1500000', payouts: 3 },
  balances: [{ federation: 'f1', msat: '1200000' }], withdrawnMsat: '300000' };

test('each program: its name, what it earned and holds, its link and its embed, the demo, Withdraw; a new one by name', async () => {
  const h = renderToStaticMarkup(React.createElement(ReferrerPanel, { programs: [P], site: 'https://testnet.bitcoin-arena.io' }));
  assert.match(h, /pays your program 10% of the nodes.{1,8}fee\. Players pay nothing extra\./);
  assert.match(h, /<h3>Demo RPS<\/h3><span class="ok">running<\/span>/);
  assert.match(h, /<span>Earned<\/span><b>1,500 sat<\/b><small>3 payouts<\/small>/);
  assert.match(h, /<span>Ready to withdraw<\/span><b>1,200 sat<\/b><small>withdrawn 300 sat<\/small>/);
  assert.match(h, new RegExp(`<code>https://testnet.bitcoin-arena.io/\\?ref=${KEY}</code>`));
  // the embed kit, not a frame (kanban #678)
  assert.match(h, new RegExp(`&lt;script src=&quot;https://testnet.bitcoin-arena.io/arena-embed.js&quot; data-game=&quot;rock-paper-scissors&quot; data-ref=&quot;${KEY}&quot; data-target=&quot;#arena-game&quot;&gt;&lt;/script&gt;`));
  assert.doesNotMatch(h, /iframe/);
  assert.match(h, new RegExp(`<a href="https://testnet.bitcoin-arena.io/referral-demo/\\?ref=${KEY}" target="_blank"`));
  assert.match(h, /<button type="button" class="primary">Withdraw<\/button>/);
  assert.match(h, /<h3>Another program<\/h3>/);
  // creating one: the name goes to create(), and what it says comes back
  const asked = [];
  const p = new ReferrerPanel({ programs: [], create: async (name) => { asked.push(name); return { name, told: 13 }; }, reread: () => {} });
  p.setState = function (c) { this.state = { ...this.state, ...c }; };
  p.state.name = '  My blog ';
  await p.create();
  assert.deepEqual(asked, ['My blog']);
  assert.equal(p.state.said.text, '"My blog" is ready. Its name reached 13 nodes.');
  assert.match(renderToStaticMarkup(p.render()), /<h3>Your first program<\/h3>/);
  // a withdrawal: an invoice as is; an address with an amount in sat, sent in msat
  const sent = [];
  const w = new ReferrerPanel({ programs: [P], withdraw: async (a) => { sent.push(a); return { id: 'w1' }; } });
  w.setState = function (c) { this.state = { ...this.state, ...c }; };
  w.state.to = { 'demo-rps': 'me@wallet.example' }; w.state.amount = { 'demo-rps': '1000' };
  await w.withdraw('demo-rps');
  assert.deepEqual(sent, [{ slug: 'demo-rps', lnAddress: 'me@wallet.example', msat: '1000000' }]);
});
