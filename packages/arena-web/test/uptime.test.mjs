// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S UPTIME ON THE PAGES (kanban #756): GET /uptime as a seat serves it, drawn on the node dashboard (the four figures, the 24 h
// marked below inclusion, no instructions), on the owner page (the same with where the 24 h matters and the warning with when it is reached
// again), on the health page (one cell per node) and on the site's node list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UptimeStats, UptimePanel, uptimePct, uptimeRows, uptimeCell, belowInclusion, whereItMatters, belowWarning } from '../dist/test/uptime.mjs';
import { DashboardPage } from '../dist/test/dashboard.mjs';
import { NodesTable, nodeView } from '../dist/test/health.mjs';
import { NodesList } from '../dist/test/site.mjs';

const NOW = Date.UTC(2026, 9, 28, 12, 0), H = 3600000, D = 24 * H;
const SINCE = NOW - 3 * D;
const win = (key, label, share, partial = false) => ({ key, label, share, partial, fromMs: 0, readFromMs: 0, ofMs: 1, upMs: 1 });
const UP = { node: 'ab'.repeat(32), nowMs: NOW, sinceMs: SINCE, spans: 3, runningSinceMs: NOW - 20 * H,
  windows: [win('24h', '24 h', 0.9993), win('7d', '7 days', 0.9512, true), win('30d', '30 days', 0.9512, true), win('all', 'All time', 0.9512)],
  inclusion: { met: true, needMs: 900000, longestRunMs: 20 * H, metAgainAtMs: null, lastMetMs: NOW, lapsesAtMs: NOW + D, seen: null, inForce: false, rule: 'protocol 22' } };
const DOWN = { ...UP, runningSinceMs: NOW - 5 * 60000, windows: [win('24h', '24 h', 0.0035), ...UP.windows.slice(1)],
  inclusion: { ...UP.inclusion, met: false, longestRunMs: 5 * 60000, metAgainAtMs: NOW + 10 * 60000 } };
const FRESH = { node: 'cd'.repeat(32), nowMs: NOW, sinceMs: null, spans: 0, windows: ['24h', '7d', '30d', 'all'].map((k) => win(k, k, null)), inclusion: { met: false, needMs: 900000, metAgainAtMs: null, inForce: false } };

test('the figures in the page\'s words: one decimal, 100 % whole, "-" while nothing is kept; "since" where the record is younger', () => {
  assert.deepEqual([uptimePct(0.9993), uptimePct(1), uptimePct(0.0035), uptimePct(null), uptimePct(0)], ['99.9 %', '100 %', '0.3 %', '-', '0.0 %']);
  const r = uptimeRows(UP);
  assert.deepEqual(r.map((x) => x.key), ['24h', '7d', '30d', 'all']);
  assert.deepEqual(r.map((x) => x.since), [null, '25 Oct 12:00 UTC', '25 Oct 12:00 UTC', '25 Oct 12:00 UTC']);
  assert.equal(belowInclusion(UP), false); assert.equal(belowInclusion(DOWN), true); assert.equal(belowInclusion(null), false);
});

test('the node dashboard: four tiles, the 24 h "inclusion reached" or "below inclusion", and no instructions', () => {
  const h = renderToStaticMarkup(React.createElement(UptimeStats, { uptime: UP }));
  for (const t of ['Uptime · 24 h', 'Uptime · 7 days', 'Uptime · 30 days', 'Uptime · All time', '99.9 %', '95.1 %', 'inclusion reached', 'since 25 Oct 12:00 UTC']) assert.ok(h.includes(t), t);
  const d = renderToStaticMarkup(React.createElement(UptimeStats, { uptime: DOWN }));
  assert.match(d, /class="bad">0\.3 %/); assert.match(d, /below inclusion \(from 2\.0\)/);
  assert.match(renderToStaticMarkup(React.createElement(UptimeStats, { uptime: { ...DOWN, inclusion: { ...DOWN.inclusion, inForce: true } } })), />below inclusion</);
  for (const x of [h, d]) assert.doesNotMatch(x, /drawn into|Keep it running|census/, 'no instructions on the public page');
  assert.equal(renderToStaticMarkup(React.createElement(UptimeStats, { uptime: null })), '');
  // in the whole page, under its own heading; a node before 756 (no /uptime) shows none
  const base = { node: 'ab'.repeat(32), nowMs: NOW, totals: { day: {}, month: {}, year: {}, owed: {} }, days: [], rounds: [], byGame: [], settlements: [], federations: [] };
  const page = renderToStaticMarkup(React.createElement(DashboardPage, { data: { ...base, uptime: DOWN } }));
  assert.match(page, /<h2>Uptime<\/h2>/); assert.match(page, /below inclusion/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DashboardPage, { data: base })), /<h2>Uptime<\/h2>/);
});

test('the owner page: the four figures, where the 24 h matters in plain words, and the warning with when it is reached again', () => {
  const h = renderToStaticMarkup(React.createElement(UptimePanel, { initial: UP }));
  for (const t of ['Uptime · 24 h', '99.9 %', 'Uptime · 30 days (since 25 Oct 12:00 UTC)', 'drawn into game and settlement committees only if it was seen online in the 24 hours',
    'From Bitcoin Arena 2.0', 'The last 24 hours reach the inclusion line.', 'keeps its uptime from 25 Oct 12:00 UTC']) assert.ok(h.includes(t), t);
  const d = renderToStaticMarkup(React.createElement(UptimePanel, { initial: DOWN }));
  assert.match(d, /class="err"><b>Below inclusion<\/b>/);
  assert.ok(d.includes('has not run 15 minutes without a break in the last 24 hours, from 2.0 that leaves a node out of the draw'));
  assert.ok(d.includes('reached again at 28 Oct 12:10 UTC'));
  // on 2.0 (protocol 22 in force): the rule as it stands now, and the census after
  const on = { ...DOWN, inclusion: { ...DOWN.inclusion, inForce: true } };
  assert.match(whereItMatters(on), /^Your node is drawn into game and settlement committees only if it was seen online in the 24 hours before the day's census/);
  assert.match(belowWarning(on), /so it is left out of the next census\. It is reached again at 28 Oct 12:10 UTC, after 15 minutes up without a break; the census after that draws it again\./);
  assert.equal(belowWarning(UP), null);
  // a fresh node: dashes, not reached, nothing said of when (it does not run yet)
  const f = renderToStaticMarkup(React.createElement(UptimePanel, { initial: FRESH }));
  assert.match(f, /Below inclusion/); assert.doesNotMatch(f, /reached again|keeps its uptime from/);
});

test('the owner page reads GET /uptime and tells the page when the 24 h is below the line', async () => {
  let told = null, asked = null;
  const c = new UptimePanel({ api: { get: async (p) => { asked = p; return DOWN; } }, onBelow: (u) => { told = u; } });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  assert.equal(asked, '/uptime'); assert.equal(c.state.uptime, DOWN); assert.equal(told, DOWN);
  const e = new UptimePanel({ api: { get: async () => { throw new Error('HTTP 404'); } } });
  e.setState = (u) => { Object.assign(e.state, u); };
  await e.componentDidMount();
  assert.match(renderToStaticMarkup(e.render()), /Uptime not readable: HTTP 404/);
});

test('the health page and the site\'s node list: one cell per node, below inclusion marked; "-" for a node without /uptime', () => {
  assert.deepEqual(uptimeCell(UP), { text: '99.9 % · 95.1 % · 95.1 % · 95.1 %', below: false, since: '25 Oct 12:00 UTC' });
  assert.equal(uptimeCell(null), null);
  const version = { ok: true, ms: 40, body: { version: '2026.1.9.12', protocols: [20] } };
  const rows = [nodeView({ node: '01'.repeat(32), base: 'https://a', version, roles: [], uptime: { ok: true, body: DOWN } }, { tip: 1, active: true }),
    nodeView({ node: '02'.repeat(32), base: 'https://b', version, roles: [], uptime: { ok: false, status: 404 } }, { tip: 1, active: true })];
  const h = renderToStaticMarkup(React.createElement(NodesTable, { rows }));
  assert.match(h, /<th>Uptime 24 h · 7 d · 30 d · all<\/th>/);
  assert.match(h, /0\.3 % · 95\.1 % · 95\.1 % · 95\.1 %<span class="bad"> · below inclusion<\/span>/);
  assert.equal((h.match(/<th>/g) || []).length, 14);
  const s = renderToStaticMarkup(React.createElement(NodesList, { rows: [{ n: 1, href: 'x', read: { node: 'ab'.repeat(32), dayMsat: '0', rounds: 2, uptime: DOWN } }, { n: 2, href: 'y', read: { node: 'cd'.repeat(32), dayMsat: '0', rounds: 0 } }] }));
  assert.match(s, /uptime <span class="v">0\.3 % · 95\.1 % · 95\.1 % · 95\.1 %<\/span><span class="bad"> below inclusion<\/span>/);
  assert.equal((s.match(/uptime </g) || []).length, 1, 'a node that did not answer /uptime shows none');
});
