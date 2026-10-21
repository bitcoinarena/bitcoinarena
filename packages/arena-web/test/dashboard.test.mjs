// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE DASHBOARD IN REACT (kanban #566): drawn from /dashboard.json as a seat serves it (the shapes measured on a test host seat,
// 2026-10-21) - the period's earnings as one number with its roles, owed and profit; the dev client as a card whose table has short dates on
// one line; rows with nothing in them left out; the rounds with their settlement's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPage, sat, short, earningsOf } from '../dist/test/dashboard.mjs';

const NOW = Date.UTC(2026, 9, 21, 11, 0);
const zero = { gameVerifyMsat: '0', settlementMsat: '0', guardianMsat: '0', otherMsat: '0', lightningCostMsat: '0', gatewayCostMsat: '0', profitMsat: '0' };
const month = { gameVerifyMsat: '9046', settlementMsat: '9046', guardianMsat: '9728', otherMsat: '0', lightningCostMsat: '7000', gatewayCostMsat: '0', profitMsat: '20820' };
const D = { node: '4003758bc18980b590c9390ff33441ca145e36a4bdb4a4932b4a52ecc1ff6300', nowMs: NOW, sinceMs: Date.UTC(2026, 8, 22), roundsChecked: 49,
  totals: { day: zero, month, year: month, owed: { gameVerifyMsat: '952', settlementMsat: '952', guardianMsat: '953' } },
  days: [{ day: '2026-10-20', ...month }, { day: '2026-10-21', ...zero }],
  rounds: [{ id: '4d2c74207c5b'.padEnd(64, '0'), game: 'a7', gameName: 'rock-paper-scissors', startMs: Date.UTC(2026, 9, 20, 19, 3), entries: 2, settlement: { state: 'ACCEPTED' }, gameVerifyMsat: '357', settlementMsat: '357', guardianMsat: '714' }],
  byGame: [{ game: 'a7', name: 'rock-paper-scissors', rounds: 2, earned: { ...zero, gameVerifyMsat: '714', settlementMsat: '714', guardianMsat: '1428' } }],
  settlements: [{ round: '4d2c74207c5b'.padEnd(64, '0'), state: 'ACCEPTED', madeMs: Date.UTC(2026, 9, 20, 19, 15) }], settlementsByState: { ACCEPTED: 1 },
  federations: [{ federation: '337ae01ad1e9'.padEnd(64, '0'), rounds: 49, firstMs: 1, lastMs: Date.UTC(2026, 9, 20, 22) }],
  devClient: { label: 'dev b', recipientPk: '02ed57f5412a004b'.padEnd(66, '0'), donations: 106, receivedMsat: '428900', withdrawnMsat: '91000',
    withdrawals: [{ state: 'Success', msat: '100', at: '2026-10-14T20:09:00Z' }], split: { protocolMsat: '41300', games: [{ title: 'Rock Paper Scissors', msat: '10600', donations: 5 }], unknownMsat: '0' },
    byFederation: [{ federation: '337ae01ad1e9'.padEnd(64, '0'), donations: 103, msat: '419500', balanceMsat: '353600' }], unclaimed: [],
    lastPass: { at: '2026-10-21T10:16:00Z', seats: 14, unanswered: 0 },
    recent: [{ round: 'ce73e57f8649'.padEnd(64, '0'), federation: '337ae01a'.padEnd(64, '0'), amountMsat: '1332', atMs: Date.UTC(2026, 9, 21, 0, 52, 21) }] },
  hosts: null };

test('the money in the page\'s words: sat with few decimals, short dates on one line, the earnings by role', () => {
  assert.deepEqual([sat('952'), sat('428900'), sat('9046000'), sat('0')], ['0.952 sat', '428.9 sat', '9046 sat', '0 sat']);
  assert.equal(short(Date.UTC(2026, 9, 21, 0, 52, 21), NOW), '21 Oct 00:52');
  assert.equal(short(Date.UTC(2025, 0, 2, 3, 4), NOW), '2 Jan 2025 03:04');
  const e = earningsOf(month);
  assert.deepEqual([e.earned, e.costs, e.profit, e.parts.map((p) => p.name)], [27820n, 7000n, 20820n, ['Game / verify', 'Settlement', 'Guardian']]);
  assert.deepEqual(earningsOf(zero).parts, [], 'nothing earned: no parts');
});

test('the page: the period switch, earned / owed / profit as stat cards, the dev client\'s card, the rounds with their settlement', () => {
  const h = renderToStaticMarkup(React.createElement(DashboardPage, { data: D }));
  assert.match(h, /<h1>Node dashboard<\/h1>/);
  assert.match(h, /<button type="button" role="tab" aria-selected="true" class="on">Today<\/button>/);
  assert.match(h, /<span>Earned · today<\/span><b>0 sat<\/b><small>nothing settled yet in this period<\/small>/);
  assert.match(h, /<span>Owed<\/span><b>2.857 sat<\/b>/);
  assert.match(h, /<h3>Dev client · dev b<\/h3>/);
  assert.match(h, /<span>Received<\/span><b>428.9 sat<\/b><small>106 donations<\/small>/);
  assert.match(h, /<td class="n nowrap">21 Oct 00:52<\/td>/, 'one short date per row');
  assert.doesNotMatch(h, /Rounds this node no longer holds/, 'an empty row is left out');
  assert.doesNotMatch(h, /Unclaimed in issuance/);
  assert.match(h, /<td class="ok">accepted<\/td>/);
  assert.match(h, /rock-paper-scissors<\/span><b>2 rounds · 2.856 sat<\/b>/);
  assert.equal((h.match(/class="stat/g) || []).length >= 5, true);
});

test('the month: the earned number, its roles as a bar, the profit after costs', () => {
  const p = new DashboardPage({ data: D });
  p.state = { period: 'month' };
  const h = renderToStaticMarkup(p.render());
  assert.match(h, /<span>Earned · this month<\/span><b>27.8 sat<\/b><div class="split"/);
  assert.match(h, /Game \/ verify 9.046 sat/);
  assert.match(h, /<span>Profit<\/span><b class="ok">20.8 sat<\/b><small>after 7 sat of Lightning and gateway costs<\/small>/);
});
