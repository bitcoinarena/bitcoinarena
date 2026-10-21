// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH PAGE'S VIEWS IN REACT (kanban #564): the facts as stat cards; a node's row as the page drew it (its answer, release,
// protocol, roles with its federation by number, bond from its own answer else the census's, the lock, active in 24 h); the inactive
// nodes folded behind one button; each federation's capacity band with its load bar and its plea, a federation not open without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Facts, NodesTable, Capacity, nodeView, capacityView } from '../dist/test/health.mjs';

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
});
