// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2773: the node dashboard shows the gateway it hosts in red at the top when the node's watch (hosts.js + gateway-watch.js)
// finds money at risk - the #2771 signs - amber for failures alone, and nothing when the gateway is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPage, GatewayWarningCard } from '../dist/test/dashboard.mjs';

const NOW = Date.UTC(2026, 10, 14, 18, 0);
const zero = { gameVerifyMsat: '0', settlementMsat: '0', guardianMsat: '0', otherMsat: '0', lightningCostMsat: '0', gatewayCostMsat: '0', profitMsat: '0' };
const gw = (warning, watch = {}) => ({ name: 'gw-c', state: 'Running', federations: [{ id: '337ae01a'.padEnd(64, '0'), name: 'A', ecashMsat: '105739638272' }],
  lightningMsat: '0', inboundMsat: '0', readAtMs: NOW, watch: { failures: { failed: 1, alreadySpent: 1, lastAtMs: Date.UTC(2026, 10, 14, 17, 44), lastError: 'The transaction had an invalid input: 2-The note is already spent' }, drops: [], ...watch }, warning });
const page = (hosts) => renderToStaticMarkup(React.createElement(DashboardPage, { data: { node: 'ab'.repeat(32), nowMs: NOW, totals: { day: zero, month: zero, year: zero }, days: [], hosts } }));

test('#2773 a gateway with money at risk is a red card at the top of the node dashboard', () => {
  const red = gw({ level: 'bad', text: 'gw-c: ...', parts: ['1 failed payment in 24 h (1 "note already spent"), 8,858,988 sat at stake', '62 dead notes (72,586,682 sat) the federation counts as spent'] });
  const html = page({ lnd: null, gateway: red });
  assert.match(html, /id="gateway-warning"/);
  assert.match(html, /Money at risk/);
  assert.match(html, /note already spent/);
  assert.match(html, /62 dead notes/);
  assert.match(html, /Last failure 14 Nov 17:44 UTC/);
  assert.ok(html.indexOf('gateway-warning') < html.indexOf('Earnings'), 'the card comes before the earnings');
});

test('#2773 failures without a loss are amber; a fine gateway shows no card', () => {
  assert.match(renderToStaticMarkup(React.createElement(GatewayWarningCard, { gateway: gw({ level: 'warn', text: 'gw-a: 1 failed payment in 24 h', parts: ['1 failed payment in 24 h'] }), nowMs: NOW })), /Payments failing/);
  assert.doesNotMatch(page({ lnd: null, gateway: gw({ level: 'ok', text: 'gw-b: no failed payments, balance explained', parts: [] }) }), /gateway-warning/);
  assert.doesNotMatch(page(null), /gateway-warning/);
});
