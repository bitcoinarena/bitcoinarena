// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH PAGE'S VIEWS IN REACT (kanban #564): the facts as stat cards; a node's row as the page drew it (its answer, release,
// protocol, roles with its federation by number, bond from its own answer else the census's, the lock, active in 24 h); the inactive
// nodes folded behind one button; each federation's capacity band with its load bar and its plea, a federation not open without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Facts, NodesTable, Capacity, Line, Machines, nodeView, capacityView, machinesView, appsView } from '../dist/test/health.mjs';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const fedNo = (f) => ({ [A]: 1, [B]: 2 })[f] || null;
const up = { ok: true, ms: 240, body: { version: '2026.1.1', commit: 'c50e65e1aa', protocols: [1, 18, 19] } };

test('facts as stat cards, the tone on the value', () => {
  const h = renderToStaticMarkup(React.createElement(Facts, { items: [['Bitcoin tip (testnet4)', '157,204', ''], ['Answering (active nodes)', '13 of 14', 'warn']] }));
  assert.match(h, /<div class="facts r"><div class="fact"><b class="">157,204<\/b><span>Bitcoin tip \(testnet4\)<\/span><\/div><div class="fact"><b class="warn">13 of 14<\/b>/);
});

test('a node\'s row: answer, release, protocol, roles with its federation by number, bond and lock, the last 24 h', () => {
  const n = { node: 'cd'.repeat(32), base: 'https://seat1.example', roles: ['game', 'settlement'], guardianOf: [A], serving: true, version: up,
    bond: { ok: true, body: { bond: { sats: '50000' }, lock: { blocksLeft: 12 } } }, gw: { ok: true } };
  const r = nodeView(n, { tip: 157204, served: { [n.node]: 3 }, fedNo, active: true });
  assert.deepEqual([r.health, r.node, r.address, r.answer, r.release, r.commit, r.protocol, r.tags, r.bond, r.lock, r.rounds24h],
    ['ok', 'cdcdcdcdcdcd', 'seat1.example', '240 ms', '2026.1.1', 'c50e65e', 19, ['game', 'settlement', 'federation 1', 'gateway'], '50,000 sat', 'matures in 12', 3]);
  const census = nodeView({ node: 'ef'.repeat(32), base: 'https://x', bondSats: '30000', bondMaturity: 157000, version: { ok: false, status: 0, why: 'no answer in 10 s' } }, { tip: 157204, fedNo, active: false });
  assert.deepEqual([census.health, census.answer, census.bond, census.lock], ['bad', 'no answer in 10 s', '30,000 sat', 'mature'], 'the census\'s bond when the node does not answer');
  assert.equal(nodeView({ node: 'ab' }, { tip: 1, fedNo, active: true }).answer, null, 'still asking');
});

test('the table: active first, the inactive folded behind one button, opened on a click', () => {
  const rows = [nodeView({ node: '01'.repeat(32), version: up, roles: [] }, { tip: 1, fedNo, active: true }), nodeView({ node: '02'.repeat(32), version: { ok: false, why: 'x' } }, { tip: 1, fedNo, active: false })];
  const t = new NodesTable({ rows }); t.setState = (u) => Object.assign(t.state, u);
  const h = renderToStaticMarkup(t.render());
  assert.equal((h.match(/<tr><td><span class="dot/g) || []).length, 1);
  assert.match(h, /▸ 1 inactive node - bonded, not answering and no round signed in 24 h<\/button>/);
  t.setState({ idleOpen: true });
  assert.equal((renderToStaticMarkup(t.render()).match(/<tr><td><span class="dot/g) || []).length, 2);
});

test('capacity: a band with its load bar and plea; a federation not open says where deposits go; the network line', () => {
  const cap = { federations: [
    { federation: A, band: 'PRESSURE', status: 'OPEN', load: 0.82, headroomSats: 54000, guardians: 7, targetBondSats: 80000, guardiansBelowTarget: [{ addSats: 30000 }, { addSats: 30000 }], gatewaysBelowTarget: [] },
    { federation: B, band: 'NOT_OPEN', status: 'DRAINING', load: 4.33 }],
    network: { band: 'PRESSURE', lowestFederation: A, lowestLoad: 0.82, targetBondSats: 80000, installMinimumBondSats: 50000 } };
  const v = capacityView(cap, [{ federation: B, successor: A }], fedNo);
  const h = renderToStaticMarkup(React.createElement(Capacity, { view: v }));
  assert.match(h, /<b>Federation 1<\/b><span class="pill warn">PRESSURE<\/span><span class="muted">OPEN<\/span><span class="muted grow">filling up<\/span><span class="muted">room 54,000 sat<\/span>/);
  assert.match(h, /<i class="warn" style="width:82%"><\/i><span>82 %<\/span>/);
  assert.match(h, /2 of 7 guardians below the bond B\* = 80,000 sat - increase your bond by 30,000 sat \(Add to bond\)/);
  assert.match(h, /<span class="pill muted">DRAINING<\/span>/); assert.match(h, /Federation 2 is draining into Federation 1: new deposits and rounds go there\./);
  assert.equal(v.rows[1].load, null, 'no bar for a federation that takes no deposits');
  assert.match(h, /<b>Network: PRESSURE<\/b> - the lowest-load OPEN federation \(Federation 1\) at 82 % · a bond of at least 80,000 sat/);
  assert.match(renderToStaticMarkup(React.createElement(Capacity, { view: capacityView(null) })), /no seat answers \/capacity yet/);
});

test('a table from the page\'s data: the dot in the first cell, parts in their classes, text never HTML, the words for none, a foot', async () => {
  const { Table } = await import('../dist/test/health.mjs');
  const h = renderToStaticMarkup(React.createElement(Table, { head: ['Federation', 'Status', 'Load'], foot: '13 of 14 seats answered',
    rows: [{ key: 'a', dot: 'bad', cls: [null, null, null], cells: [['Federation 1', { t: '337ae01a', c: 'muted mono' }], ['OPEN', '·', { t: 'FULL', c: 'bad' }], { t: '433 %', c: 'bad' }] },
      { key: 'b', cells: ['<img src=x>', '-', 7] }] }));
  assert.match(h, /<td><span class="dot bad"><\/span>Federation 1 <span class="muted mono">337ae01a<\/span><\/td><td>OPEN · <span class="bad">FULL<\/span><\/td><td><span class="bad">433 %<\/span><\/td>/);
  assert.match(h, /<td>&lt;img src=x&gt;<\/td><td>-<\/td><td>7<\/td>/);
  assert.match(h, /<tr><td colspan="3" class="muted">13 of 14 seats answered<\/td><\/tr>/i);
  assert.match(renderToStaticMarkup(React.createElement(Table, { head: ['A', 'B'], rows: [], empty: 'no node serves a liquidity claim' })), /<td colspan="2" class="muted">no node serves a liquidity claim<\/td>/i);
  // a status with its why as a tooltip (kanban #692: "with a tooltip why it's delayed or failed")
  assert.match(renderToStaticMarkup(React.createElement(Table, { head: ['App', 'Rounds today'], rows: [{ key: 'u', cells: ['Up/Down', { t: 'failed', c: 'bad', tip: 'Federation 1: no seat can draw its committee' }] }] })),
    /<button type="button" class="tip bad" title="Federation 1: no seat can draw its committee" aria-expanded="false">failed<\/button>/);   // a tap opens it too (#692)
});

test('the reasons panel has a close button top right (2026-10-26: "a regular X button on the top right corner")', () => {
  const src = readFileSync(new URL('../src/health/HealthViews.jsx', import.meta.url), 'utf8');
  assert.match(src, /className=\{top \? 'tip-pop top' : 'tip-pop'\} role="dialog">[\s\S]{0,260}<button type="button" className="tip-x" aria-label="Close" onClick=\{close\}>×<\/button>/);
  // closed by a click outside or Esc, never by a click inside; one panel at a time (2026-10-26 ~15:10Z)
  assert.match(src, /addEventListener\('pointerdown', outside\)/);
  assert.match(src, /if \(closeOpenTip\) closeOpenTip\(\);/);
  assert.doesNotMatch(src, /tap to close/);
  assert.match(readFileSync(new URL('../../../src/arena-ui/health/index.html', import.meta.url), 'utf8'), /\.tip-x \{ position: sticky; top: 0; float: right;/);
});

test('a bar cell: how far, green when done', async () => {
  const { Table, barPct } = await import('../dist/test/health.mjs');
  assert.deepEqual([barPct(90, 100), barPct(7, 6), barPct(0, 0)], [90, 100, 0]);
  const h = renderToStaticMarkup(React.createElement(Table, { head: ['What', ''], rows: [{ key: 'p', cells: ['peg-in', { bar: [90, 100] }] }, { key: 'g', cells: ['grid', { bar: [67, 6] }] }] }));
  assert.match(h, /<span class="tbar"><i class="warn" style="width:90%"><\/i><\/span>/);
  assert.match(h, /<span class="tbar"><i class="ok" style="width:100%"><\/i><\/span>/);
});

test('the reading state as one line: plain, or red with why', () => {
  assert.equal(renderToStaticMarkup(React.createElement(Line, { text: 'read 21:40:12 UTC · 24 nodes asked' })), 'read 21:40:12 UTC · 24 nodes asked');
  assert.equal(renderToStaticMarkup(React.createElement(Line, { text: 'could not read the network: <x>', bad: true })), '<span class="bad">could not read the network: &lt;x&gt;</span>');
  // kanban #686: a kept copy older than 5 minutes says so in yellow
  assert.equal(renderToStaticMarkup(React.createElement(Line, { text: 'Data from 12 min ago (08:41 UTC), refreshing …', warn: true })), '<span class="warn">Data from 12 min ago (08:41 UTC), refreshing …</span>');
});

// MACHINES AND APPS (kanban #597, testnet4 only): nodes grouped by the machine each names, its load, its nodes' earnings summed; every app's
// newest version and what the nodes earned from it, all versions under one name
const dash = (totalMsat, monthMsat, byGame = []) => ({ ok: true, body: { totals: { total: { gameVerifyMsat: String(totalMsat), settlementMsat: '0', guardianMsat: '0', otherMsat: '0', lightningCostMsat: '7000' },
  month: { gameVerifyMsat: '0', settlementMsat: String(monthMsat), guardianMsat: '0', otherMsat: '0' } }, byGame } });
const on = (id, extra = {}) => ({ ok: true, ms: 100, body: { version: '2026.1.7', protocols: [19], machine: { id, name: null, load: [6.28, 7.36, 7.94], cores: 16, os: 'Linux', ...extra } } });

test('machines: nodes grouped by machine, load and earnings in the title, folded until clicked; nodes that name none counted', () => {
  const nodes = [
    { node: '11'.repeat(32), base: 'https://a', version: on('m1'), dash: dash(23678, 9000) },
    { node: '22'.repeat(32), base: 'https://b', version: on('m1', { name: 'test host' }), dash: dash(1000, 1000) },
    { node: '33'.repeat(32), base: 'https://c', version: on('m2', { load: [20.4, 21, 22.7], cores: 12 }) },
    { node: '44'.repeat(32), base: 'https://d', version: up },
    { node: '55'.repeat(32), base: 'https://e', version: { ok: false, why: 'no answer' } },
  ];
  const v = machinesView(nodes);
  assert.equal(v.unnamed, 1, 'an answering node of an older release is counted, an unanswering one is not');
  assert.deepEqual(v.machines.map((m) => [m.title, m.nodes.length, m.total, m.month, m.tone]), [['test host', 2, 24, 10, 'ok'], ['Machine 2', 1, 0, 0, 'bad']]);
  assert.equal(v.machines[1].nodes[0].total, null, 'a node whose dashboard did not answer earns "-", not 0');
  const h = renderToStaticMarkup(React.createElement(Machines, { view: v }));
  assert.match(h, /<b>test host<\/b><span class="tag">Linux<\/span>.*2 nodes.*load 6\.28 · 7\.36 · 7\.94.*16 cores.*earned 24 sat.*this month 10 sat/);
  assert.doesNotMatch(h, /<table>/, 'a machine opened before a click');
  assert.match(h, /1 answering node name no machine/);
  assert.match(renderToStaticMarkup(React.createElement(Machines, { view: machinesView([]) })), /no node names its machine yet/);
});

test('apps: the newest version, and every version\'s earnings under the app\'s name, in sat', () => {
  const games = [{ id: 'aa'.repeat(32), name: 'btc-updown-15m', title: 'Bitcoin Up or Down', type: 'market', version: 18 },
    { id: 'ab'.repeat(32), name: 'btc-updown-15m', title: 'Bitcoin Up or Down', type: 'market', version: 19 },
    { id: 'cc'.repeat(32), name: 'nextblock', title: 'Tick Tock', type: 'game', version: 5 }];
  const g = (game, e, m) => ({ game, name: 'x', earned: { gameVerifyMsat: String(e), settlementMsat: '0', guardianMsat: '0', otherMsat: '0' }, month: { gameVerifyMsat: String(m) } });
  const nodes = [{ dash: dash(0, 0, [g('aa'.repeat(32), 5000, 1000), g('ab'.repeat(32), 3000, 3000)]) }, { dash: dash(0, 0, [g('AB'.repeat(32), 2000, 0), g('ee'.repeat(32), 9000, 0)]) }];
  const rows = appsView(games, nodes);
  assert.deepEqual(rows.map((a) => [a.title, a.newest, a.total, a.month]), [['Bitcoin Up or Down', 19, 10, 4], ['x', null, 9, 0], ['Tick Tock', 5, 0, 0]]);
});

test('kanban #1322 / #1366 (b): a test network\'s federation that would not open on mainnet says so on its card; one that would says nothing', () => {
  const warn = 'On mainnet this federation would not open: its two gateways\' peg-ins (2 × 50,000 sat) are more than a quarter of what its bonds cover (25,000 sat). On testnet4 it opens anyway.';
  const v = capacityView({ federations: [{ federation: A, band: 'CALM', status: 'OPEN', load: 0.1, headroomSats: 90000, opensWarning: warn }, { federation: B, band: 'CALM', status: 'OPEN', load: 0.1, headroomSats: 90000 }], network: {} }, [], fedNo);
  const h = renderToStaticMarkup(React.createElement(Capacity, { view: v }));
  assert.equal((h.match(/class="warnline"/g) || []).length, 1);
  assert.ok(h.includes('<p class="warnline">On mainnet this federation would not open: its two gateways&#x27; peg-ins (2 × 50,000 sat) are more than a quarter of what its bonds cover (25,000 sat). On testnet4 it opens anyway.</p>'), h);
});
