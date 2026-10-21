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
