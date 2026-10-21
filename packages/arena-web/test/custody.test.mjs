// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CUSTODY AND LIQUIDITY SCREENS IN REACT (kanban #564): a guardian or how to add custody; a provider against the deposit minimum,
// its channels, its top-up address and a new one asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustodyPanel, LiquidityPanel, standingOf } from '../dist/test/custody.mjs';

test('custody: a guardian with its endpoint; a node without custody told how to add it', () => {
  const on = renderToStaticMarkup(React.createElement(CustodyPanel, { initial: { loaded: true, guardian: { guardian: true, endpoint: 'wss://x/guardian' } } }));
  assert.match(on, /this node is a guardian/); assert.match(on, /wss:\/\/x\/guardian/);
  const off = renderToStaticMarkup(React.createElement(CustodyPanel, { initial: { loaded: true, guardian: { guardian: false } } }));
  assert.match(off, /holds no custody/); assert.match(off, /arena-install --add-custody/);
});

test('liquidity: below the minimum with how much to top up; the channels given count; a new address asked for, signed', async () => {
  const claim = { freeSats: '250000', channels: [{ peer: '02' + 'ab'.repeat(32), capacitySats: '150000' }], depositAddress: 'tb1qold' };
  assert.deepEqual(standingOf(claim), { min: 500000, free: 250000, given: claim.channels, givenSats: 150000, held: 400000, short: 100000 });
  const html = renderToStaticMarkup(React.createElement(LiquidityPanel, { initial: { loaded: true, claim } }));
  assert.match(html, /topped up by 100,000 sat/); assert.match(html, /1 \(150,000 sat\)/); assert.match(html, /tb1qold/);
  let addr = 'tb1qold'; const sent = [];
  const api = { get: async () => ({ ...claim, depositAddress: addr }), signed: async (a) => ({ a }), post: async (p, b) => { sent.push([p, b.a]); addr = 'tb1qnew'; return { ok: true, address: 'tb1qnew' }; } };
  const c = new LiquidityPanel({ api }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.read(); await c.newAddress();
  assert.deepEqual(sent, [['/owner/liquidity/new-address', 'liquidity/new-address']]);
  assert.deepEqual([c.state.claim.depositAddress, c.state.message], ['tb1qnew', 'New address: tb1qnew']);
  assert.match(renderToStaticMarkup(React.createElement(LiquidityPanel, { initial: { loaded: true, claim: null } })), /no liquidity provider/);
});

test('liquidity: a node that is none becomes one on this page - the plan (signed, no post), then the confirm (post) - no arena-install', async () => {
  const none = renderToStaticMarkup(React.createElement(LiquidityPanel, { initial: { loaded: true, claim: null } }));
  assert.doesNotMatch(none, /arena-install/, 'kanban #567: no command for an owner action');
  assert.match(none, /<button[^>]*>Set up<\/button>/);
  const plan = { lightningPubkey: '03' + 'cd'.repeat(32), depositSats: 500000, channelSats: 100000, walletSats: 312380, reservedSats: 50000, shortSats: 238620, address: 'tb1pnode' };
  const sent = [];
  const api = { get: async () => null, signed: async (a, args) => ({ a, args }), post: async (p, b) => { sent.push([p, b.a, b.args.post]); return b.args.post ? { ok: true, plan, done: { roles: ['verify', 'liquidity'] } } : { ok: true, plan }; } };
  const c = new LiquidityPanel({ api, initial: { loaded: true, claim: null } }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.review();
  const shown = renderToStaticMarkup(c.render());
  assert.match(shown, /<span>Deposit into LND<\/span><b>500,000 sat<\/b><small>5 channels of 100,000 sat<\/small>/);
  assert.match(shown, /50,000 sat kept for the gateway&#x27;s peg-in/);
  assert.match(shown, /<b>238,620 sat short<\/b>[\s\S]*tb1pnode/);
  assert.match(shown, />Become a liquidity provider<\/button>/);
  const t = global.setTimeout; global.setTimeout = () => 0;
  try { await c.become(); } finally { global.setTimeout = t; }
  assert.deepEqual(sent, [['/owner/liquidity/become', 'liquidity/become', false], ['/owner/liquidity/become', 'liquidity/become', true]]);
  assert.match(renderToStaticMarkup(c.render()), /is a liquidity provider now ✓/);
  const refused = new LiquidityPanel({ api: { ...api, post: async () => ({ ok: false, why: 'this node has no Lightning (LND) set up yet' }) }, initial: { loaded: true, claim: null } });
  refused.setState = (u) => { Object.assign(refused.state, u); };
  await refused.review();
  assert.match(renderToStaticMarkup(refused.render()), /no Lightning \(LND\) set up yet/);
});

test('liquidity: a node without LND - the plan says it is installed now; the confirm asks again while LND starts, then it is done', async () => {
  const plan = { lightning: 'install', lightningPubkey: null, depositSats: 500000, channelSats: 100000, walletSats: 600000, reservedSats: 0, shortSats: 0, address: 'tb1pnode' };
  const answers = [{ ok: true, plan, waiting: 'LND is installed and starting (not reachable from outside: Tor gives LND an onion address)' }, { ok: true, plan, waiting: 'LND is starting: not answering yet' }, { ok: true, plan, done: {} }];
  let posts = 0;
  const api = { get: async () => null, signed: async (a, args) => ({ a, args }), post: async (_p, b) => (b.args.post ? answers[posts++] : { ok: true, plan }) };
  const c = new LiquidityPanel({ api, initial: { loaded: true, claim: null } }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.review();
  assert.match(renderToStaticMarkup(c.render()), /<span>Lightning \(LND\)<\/span><b>Installed now<\/b><small>on your Bitcoin Core; Tor if no port is open<\/small>/);
  const later = []; const t = global.setTimeout; global.setTimeout = (f) => { later.push(f); return 0; };
  try {
    await c.become();
    assert.equal(c.state.message, answers[0].waiting); assert.equal(c.state.busy, true);
    await later.shift()(); await new Promise((ok) => t(ok, 0));
    assert.equal(c.state.message, 'LND is starting: not answering yet');
    await later.shift()(); await new Promise((ok) => t(ok, 0));
  } finally { global.setTimeout = t; }
  assert.equal(posts, 3);
  assert.match(renderToStaticMarkup(c.render()), /is a liquidity provider now ✓/);
});
