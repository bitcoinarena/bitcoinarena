// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE DASHBOARD IN REACT (kanban #566): drawn from /dashboard.json as a seat serves it (the shapes measured on a test host seat,
// 2026-10-21) - the period's earnings as one number with its roles, owed and profit; the dev client as a card whose table has short dates on
// one line; rows with nothing in them left out; the rounds with their settlement's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FaucetGrants, DashboardPage, Players, Liquidity, sat, short, earningsOf, signedSat, score, keep, ownerHref, bondHref } from '../dist/test/dashboard.mjs';

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
  // THE RELEASE BESIDE THE TITLE (kanban #674: "include version in node dashboard and owner dashboard"); none from a checkout
  assert.match(renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...D, release: { version: '2026.1.9.3', commit: 'a55f40bd0f81' } } })),
    /<h1>Node dashboard<span class="ver" id="release">2026\.1\.9\.3<\/span><\/h1>/);
  assert.match(h, /<button type="button" role="tab" id="earn-tab-day" aria-controls="earn-panel" aria-selected="true" tabindex="0" class="on">Today<\/button>/);
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

// WHAT THE PAGE'S OWN SCRIPT DREW, NOW HERE (kanban #564, 2026-10-21: "Delete the old html code of those components you have ported,
// no fall backs"): a round opened to its players (the nets of the 2026-10-05 follow-up on comment 318), the notes, every host row, the
// capacity plea, the liquidity card, and the words for a dashboard.json that could not be read.
test('an opened round\'s players: the net with its sign, ok / bad by its sign, pending blank, each with its replay', () => {
  assert.deepEqual([signedSat('286000'), signedSat('-4000'), signedSat('0'), signedSat(null)], ['+286 sat', '-4 sat', '0 sat', '']);
  assert.deepEqual([score(500000), score(null), score(123)], ['5.00000', '-', '0.00123']);
  const row = (p) => ({ entry: 'e'.repeat(64), player: 'p'.repeat(64), stakeMsat: '100000', score: 500000, signedBy: 2, ...p });
  const h = renderToStaticMarkup(React.createElement(Players, { result: { id: 'r1', free: false, players: [
    row({ name: 'winner', outcome: 'DELIVERED', result: 'won', netMsat: '286000' }), row({ name: 'loser', outcome: 'FORFEIT', result: 'lost', netMsat: '-100000' }),
    row({ name: 'waiting', outcome: null, result: 'pending', netMsat: null }), row({ name: 'even', outcome: 'FAILED', result: 'stake back', netMsat: '0' })] } }));
  assert.match(h, /<th>Won or lost<\/th><th class="n">Net<\/th><th>Replay<\/th>/);
  assert.match(h, /<td>winner<\/td><td>DELIVERED<\/td><td class="n">5.00000<\/td><td class="n">2<\/td><td class="n">100 sat<\/td><td class="ok">won<\/td><td class="n ok">\+286 sat<\/td>/);
  assert.match(h, /<td class="bad">lost<\/td><td class="n bad">-100 sat<\/td>/);
  assert.match(h, /<td>waiting<\/td><td>not signed yet<\/td>.*?<td>pending<\/td><td class="n"><\/td>/, 'pending: blank, no class');
  assert.match(h, /<td>stake back<\/td><td class="n">0 sat<\/td>/, 'zero: no "+", no class');
  assert.match(h, /<a href="replay\?round=r1&amp;entry=e{64}" target="_blank" rel="noopener">replay<\/a>/);
  assert.match(renderToStaticMarkup(React.createElement(Players, { result: { error: 'HTTP 404' } })), /could not read api\/round-result: HTTP 404/);
  assert.match(renderToStaticMarkup(React.createElement(Players, { result: { loading: true } })), /reading api\/round-result…/);
  assert.match(renderToStaticMarkup(React.createElement(Players, { result: { id: 'r1', players: [] } })), /no players in this round/);
});

test('a round row opens to its players, read once through readResult; a second click closes it', async () => {
  const asked = [];
  const p = new DashboardPage({ data: D, readResult: async (id) => { asked.push(id); return { id, players: [] }; } });
  p.setState = (u) => Object.assign(p.state, typeof u === 'function' ? u(p.state) : u);
  const id = D.rounds[0].id;
  assert.match(renderToStaticMarkup(p.render()), /<tr class="rr" aria-expanded="false">/);
  await p.toggle(id);
  assert.deepEqual(asked, [id]);
  assert.match(renderToStaticMarkup(p.render()), /<tr class="pl"><td colSpan="6"><p class="sub">no players in this round<\/p><\/td><\/tr>/i);
  await p.toggle(id); await p.toggle(id);
  assert.deepEqual(asked, [id], 'read once');
});

test('the notes (hyphens kept), every host row, the capacity plea and the liquidity card; an unreadable dashboard.json', () => {
  const now = NOW;
  const hosts = { lnd: { alias: 'lnd-testnet4', pubkey: '0274e26122c7b8fc00', activeChannels: 1, localMsat: '1082086628', remoteMsat: '459114372', routingFeesMsat30d: '0', forwards30d: 0, paidFeesMsat: '8000', paymentsWithFee: 2, readAtMs: now },
    gateway: { name: 'gw-a', state: 'Running', federations: [{ id: '337ae01a', name: 'blwp-testnet4', ecashMsat: '248999936' }], lightningMsat: '1082086628', inboundMsat: '459114372', onchainSat: '20446',
      payments30d: { incoming: { success: 0, failure: 0, feesMsat: '0' }, outgoing: { success: 0, failure: 2, feesMsat: '0' } }, readAtMs: now } };
  const notes = { guardian: 'the guardian third', lightning: 'this node hosts LND lnd-testnet4', gateway: 'this node pays no gateway' };
  const h = renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...D, hosts, notes, capacity: { level: 'bad', says: 'this node is full' },
    liquidity: { freeSats: '300000', channels: [{ capacitySats: '100000' }], depositAddress: 'tb1qexample' } } }));
  assert.equal(keep('lnd-testnet4'), 'test-host\u2011testnet4');
  // three short rows, the node's sentence as each row's tooltip (2026-10-26: "This is also a wall of text")
  // one slim line (2026-10-26: "Money Notes looks like a space waster, re arrange it to be more space efficient")
  assert.match(h, /<div class="note-strip" id="money-notes"><span title="the guardian third"><b>Guardian fees<\/b> none until it guards a federation<\/span><span title="this node hosts LND lnd-testnet4"><b>Lightning<\/b> LND test-host‑testnet4<\/span><span title="this node pays no gateway"><b>Gateway<\/b> gw‑a · no cost<\/span><\/div>/);
  assert.doesNotMatch(h, /<h3>Notes<\/h3>/);
  assert.match(h, /<h3>Hosts<\/h3>/);
  for (const [k, v] of [['Node key', '0274e26122c7b8fc…'], ['Fees its payments paid', '8 sat · 2 payments'], ['E-cash in blwp-testnet4', '249000 sat'], ['Lightning balance', '1082087 sat'],
    ['On-chain', '20446 sat'], ['Payments out, 30 days', '0 ok · 2 failed · fees 0 sat'], ['Read', '21 Oct 11:00']])
    assert.ok(h.includes(`<span>${k}</span><b>${v}</b>`), `${k}: ${v}`);
  assert.match(h, /<h2>Capacity<\/h2><div class="card"><p class="bad">this node is full<\/p>/);
  assert.match(h, /<h2>Liquidity provider<\/h2>/);
  assert.match(h, /<p class="bad">Below the deposit minimum: no share of the liquidity pool until topped up.<\/p>/);
  assert.ok(h.includes('<span>Channels given</span><b>1 (100,000 sat)</b>'));
  assert.ok(h.includes('<span>Top up (LND wallet)</span><b><code>tb1qexample</code></b>'));
  const ok = renderToStaticMarkup(React.createElement(Liquidity, { claim: { freeSats: '500000', channels: [] } }));
  assert.match(ok, /<p class="ok">Above the deposit minimum/);
  assert.equal(renderToStaticMarkup(React.createElement(DashboardPage, { data: { error: 'HTTP 502' } })),
    '<div class="dash"><h1>Node dashboard</h1><p class="bad">could not read dashboard.json: HTTP 502</p></div>');
});

test('the dev client card: its last recovery', () => {
  const dev = { ...D.devClient, lastRecovery: { at: '2026-10-21T09:00:00Z', ok: true, unclaimedMsat: '2000' } };
  const h = renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...D, devClient: dev } }));
  assert.ok(h.includes('<span>Last recovery</span><b>21 Oct 09:00 · ok, +2 sat</b>'));
});

// THE OWNER AREA ON THE ARENA SITE (2026-10-26, the owner on 2026.1.9.9: "It works via owner page but not Open Dashboard"): the link went to
// this node's own page on 127.0.0.1, which never holds the key the site's page keeps
test('the Owner area link: the site\'s owner page for this node, with the local address when the dashboard is the node\'s own', () => {
  const key = 'ab'.repeat(32);
  assert.equal(ownerHref(key, { hostname: '127.0.0.1', origin: 'http://127.0.0.1:8770' }), `https://testnet.bitcoinarena.io/owner/#node=${key}&local=http%3A%2F%2F127.0.0.1%3A8770`);
  assert.equal(ownerHref(key, { hostname: 'x.trycloudflare.com', origin: 'https://x.trycloudflare.com' }), `https://testnet.bitcoinarena.io/owner/#node=${key}`);
  assert.equal(ownerHref('not a key', null), 'Dashboard/owner');
});

// NO BOND ON THE DASHBOARD (kanban #728, 2026-10-27: "Wenn kein Bond da ist, muss das deutlich sichtbar sein im Dashboard"): the red card at
// the top with "Set up the bond" to the owner area's Bond section; no Federation card, no "3/10"
test('no bond: the red card first, linking to the Bond section; no founding shown', () => {
  const key = 'ab'.repeat(32);
  assert.equal(bondHref(key, { hostname: '127.0.0.1', origin: 'http://127.0.0.1:8770' }), `https://testnet.bitcoinarena.io/owner/#node=${key}&local=http%3A%2F%2F127.0.0.1%3A8770&section=bond`);
  assert.equal(bondHref('not a key', null), 'Dashboard/owner#bond');
  const setup = { ok: true, bond: null, gateway: { ok: true, federations: 0 }, founding: { waiting: true, ready: 3, needed: 10 } };
  const html = renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...D, setup } }));
  assert.match(html, /<header class="dash-head">[\s\S]*?<\/header><section><div class="card no-bond" id="no-bond"[\s\S]*?<h3>No bond<\/h3>[\s\S]*?href="https:\/\/testnet\.bitcoin-?arena\.io\/owner\/#node=4003758bc189[0-9a-f]*&amp;section=bond">Set up the bond<\/a>/);
  assert.doesNotMatch(html, /founding-wait|nodes ready for the next federation|3\/10/);
  const bonded = renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...D, setup: { ...setup, bond: { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 9, needed: 6 } } } }));
  assert.doesNotMatch(bonded, /id="no-bond"/);
  assert.match(bonded, /<span class="founding-n">3\/10<\/span>/, 'with a bond the founding shows as before');
});

test('the faucet\'s card: new and returning accounts apart, with what they got in all and today; no answer, no card (kanban #926)', async () => {
  const part = (accounts, grants, sats, today) => ({ accounts, grants, sats, today: { accounts: 1, grants: 1, sats: today } });
  const t = { ok: true, newAccounts: part(3, 3, 1500, 500), returning: part(2, 4, 1000, 250), totalSats: 2500 };
  const c = new FaucetGrants({});
  assert.equal(c.render(), null);
  c.state = { t };
  const h = renderToStaticMarkup(c.render());
  assert.match(h, /New accounts/);
  assert.match(h, /Returning/);
  assert.match(h, /1,500 sat/);
  assert.match(h, /2,500 sat in all/);
  assert.equal(new FaucetGrants({}).state.t, null);
});

test('kanban #1282: an opened paid round shows its stake against the ceiling above its players, in the owner page\'s words', () => {
  const ceiling = { ok: false, stakeSats: '20000', ceilingSats: '8000', tableCeilingSats: '100000', incomeSeatSats: '8000', binds: 'income', enforced: false };
  const h = renderToStaticMarkup(React.createElement(Players, { result: { id: 'r1', free: false, ceiling, players: [] } }));
  assert.ok(h.startsWith('<p class="sub ceiling bad">stake 20,000 of a ceiling of 8,000 sat (census table 100,000 sat, one seat&#x27;s season income 8,000 sat; the income binds) - above it: shown only, not enforced on a test network</p>'), h);
  assert.match(h, /no players in this round/);
});
