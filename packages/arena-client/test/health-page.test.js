// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE ASKS ONLY PUBLIC DOORS (kanban #526): every path src/arena-ui/health/index.html asks a node is a GET the
// nodes document as needing no authentication (src/website/docs/endpoints.json), the page's script parses, and it never asks more than
// six requests at once with a time limit on each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/health/index.html', import.meta.url), 'utf8');
const ENDPOINTS = JSON.parse(readFileSync(new URL('../../../src/website/docs/endpoints.json', import.meta.url), 'utf8'));
const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];

test('the health page asks the nodes only public GET doors the API reference lists', () => {
  const asked = new Set();
  for (const m of script.matchAll(/['`](\/[a-z][a-z0-9./-]*)(?:\?[^'`]*)?['`]/g)) asked.add(m[1]);
  assert.ok(asked.size >= 10, `too few paths read off the page: ${[...asked]}`);
  const open = new Set(ENDPOINTS.filter((e) => e.method === 'GET' && e.auth === 'none' || e.method === 'GET' && String(e.auth).startsWith('none'))
    .flatMap((e) => String(e.path).split(/\s+\(also\s+|\)/).map((p) => p.trim()).filter((p) => p.startsWith('/'))));
  const unknown = [...asked].filter((p) => !open.has(p));
  assert.deepEqual(unknown, [], 'asked but not a public GET in endpoints.json');
});

test('the page script parses, and it limits itself: six at once, 10 s each, every 60 s', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const ASK_MS = 10000, AT_ONCE = 6;/);
  assert.match(script, /signal: AbortSignal\.timeout\(ASK_MS\)/);
  assert.match(script, /setInterval\(read, 60000\)/);
});

test('each federation\'s gateway row is its own guardians\' answer, not the first seat\'s', async () => {
  // measured 2026-10-19 ~21:15Z: a guardian seat ranks only its own federation (the ?federation= is not read), so the first seat that
  // answered - one of A's - filled B's row with A's epoch and "0 of 2" too
  const at = script.indexOf('  async function paintGateways(');
  const src = script.slice(at, script.indexOf('\n  }\n', at) + 4);
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const C = 'cc'.repeat(32), D = 'dd'.repeat(32), E = 'ee'.repeat(32);
  const answers = { a1: { federationId: A, epoch: 1090, seated: ['01'.repeat(32)], why: 'A ranked', waiting: [{ node: E, why: 'the same operator as 0101010101, whose node stands for it (one seat per operator)' }] },
    b1: { federationId: B, epoch: 1090, seated: [], why: 'B ranked', ineligible: [{ node: C, why: 'peg-in 0 below 50000 sat' }],
      gateways: { [C]: { pending: { pegIns: [{ txid: 'f3'.repeat(32), vout: 1, sats: 55000, confirmations: 2, finality: 100 }] } } } } };
  const ask = async (s) => ({ ok: true, body: answers[s] });
  // the page's tables are data (kanban #564): drawTable is handed in and keeps what each table was given
  const tables = {};
  const fn = new Function('ask', 'drawTable', 'fedCell', 'cut', 'sat', src + '\nreturn paintGateways;')(ask, (id, head, rows, empty, foot) => { tables[id] = { head, rows, empty, foot }; },
    (f) => String(f).slice(0, 12), (x, n) => String(x).slice(0, n), (x) => Number(x).toLocaleString('en-US'));
  await fn([{ federation: A }, { federation: B }], ['a1', 'b1'], []);
  const fedRows = tables.gateways.rows.filter((r) => r.dot);
  assert.deepEqual(fedRows.map((r) => [r.dot, r.cells[0], r.cells[2], r.cells[4].t]), [['warn', 'aaaaaaaaaaaa', '1 of 2', 'A ranked'], ['bad', 'bbbbbbbbbbbb', '0 of 2', 'B ranked']], 'B is ranked by a seat of B');
  assert.equal(tables.gateways.foot, 'Nodes that claim a gateway: none');
  // PENDING GATEWAYS (kanban #552): what each one waits for, a peg-in with its confirmations against the finality and about when it counts
  const pending = tables['gw-pending'].rows;
  assert.equal(pending.length, 2);
  assert.deepEqual([pending[0].dot, pending[0].cells[0], pending[0].cells[1], pending[0].cells[2][0]], ['warn', 'aaaaaaaaaaaa', 'eeeeeeeeee', 'waits: the same operator as 0101010101, whose node stands for it (one seat per operator)']);
  assert.deepEqual([pending[1].dot, pending[1].cells[0], pending[1].cells[1]], ['bad', 'bbbbbbbbbbbb', 'cccccccccc']);
  assert.deepEqual(pending[1].cells[2], ['not eligible: peg-in 0 below 50000 sat', '· peg-in 55,000 sat ·', { t: '2 of 100', c: 'strong' }, 'confirmations · counts in about 17 h', { t: 'f3f3f3f3:1', c: 'mono muted' }, { bar: [2, 100] }]);
});

test('the Capacity card: each federation\'s band, who is below B* and by how much, the network with the install minimum - handed to React', async () => {
  // spec §23A.3a, kanban #543: from the seats' GET /capacity (capacityView, arena-protocol)
  const { capacityView } = await import('../../arena-protocol/src/capacity.js');
  const view = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, federations: [
    { federation: 'aa'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '130000', exposureCapSats: '150000',
      guardianBonds: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ node: String(i), bondSats: 50000n })), gateways: [{ node: '1', pegInSats: 20000n }] },
    { federation: 'bb'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '650000', exposureCapSats: '150000', guardianBonds: [], gateways: [] },
    { federation: 'cc'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '10000', exposureCapSats: '150000', guardianBonds: [], gateways: [] }] });
  // what the seats answer, which the page hands on: the bands, B* and how much each guardian adds, P*, the network with the install minimum
  assert.deepEqual(view.federations.map((f) => f.band), ['PRESSURE', 'FULL', 'CALM']);
  assert.deepEqual([view.federations[0].guardiansBelowTarget.length, String(view.federations[0].targetBondSats), String(view.federations[0].guardiansBelowTarget[0].addSats), view.federations[0].gatewaysBelowTarget.length],
    [7, '86667', '36667', 1]);
  assert.deepEqual([view.network.band, String(view.network.installMinimumBondSats)], ['CALM', '180000']);
  // kanban #553: a federation that takes no deposits (draining into its successor) has no band and no plea
  const drain = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, federations: [{ federation: 'dd'.repeat(32), status: 'CRITICAL', nominal: 7, reserveSats: '108000', exposureCapSats: '150000',
    guardianBonds: [1, 2, 3].map((i) => ({ node: String(i), bondSats: 50000n })), gateways: [] }] });
  assert.deepEqual([drain.federations[0].band, drain.federations[0].guardiansBelowTarget.length], ['NOT_OPEN', 0]);
  // THE PAGE HANDS IT TO REACT (kanban #564: the card is HealthViews' Capacity, its words tested in arena-web's health test):
  // H.capacityView(the answer, the federations, the page's numbering), drawn into #capacity, and the answer kept for a probe
  const at = script.indexOf('  function paintCapacity(cap, feds = []) {');
  const src = script.slice(at, script.indexOf('\n  }\n', at) + 4);
  const drawn = [], made = []; const window = {};
  const H = { capacityView: (...a) => { made.push(a); return { made: a.length }; }, draw: (el, kind, props) => drawn.push([el, kind, props]) };
  const fedNoOf = (f) => ({ ['dd'.repeat(32)]: 2, ['ee'.repeat(32)]: 3 })[f] || null;
  const paint = new Function('$', 'window', 'fedNoOf', 'H', src + '\nreturn paintCapacity;')((id) => '#' + id, window, fedNoOf, H);
  const feds = [{ federation: 'dd'.repeat(32), successor: 'ee'.repeat(32) }];
  paint({ body: drain }, feds);
  assert.deepEqual(made, [[drain, feds, fedNoOf]]);
  assert.deepEqual(drawn, [['#capacity', 'capacity', { view: { made: 3 } }]]);
  assert.equal(window.ARENA_HEALTH_CAPACITY, drain);
  // no seat answered: React's card says so (capacityView(null) is its "no seat answers /capacity yet")
  paint(null);
  assert.deepEqual([made[1][0], made[1][1]], [null, []]);
  assert.equal(drawn.length, 2);
});

test('Waiting for a founding: the guardian-capable nodes free of an OPEN federation, ready first, with the founding that runs (kanban #585)', () => {
  const at = script.indexOf('  function paintFounding(nodes, feds) {');
  const src = script.slice(at, script.indexOf('\n  }\n', at) + 4);
  const drawn = [];
  const H = { draw: (el, kind, props) => drawn.push([el, kind, props]) };
  const sat = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-US'));
  const cut = (h, n = 8) => (h ? String(h).slice(0, n) : '-');
  const drawTable = (id, head, rows, empty, foot) => drawn.push([id, 'table', { head, rows, empty, foot }]);
  const paint = new Function('$', 'H', 'sat', 'cut', 'drawTable', src + '\nreturn paintFounding;')((id) => '#' + id, H, sat, cut, drawTable);
  const ok = { ok: true };
  const run = { id: 'f0'.repeat(32), windowEnd: 157302, seated: [{ node: 'a1'.repeat(32), position: 0 }, { node: 'a2'.repeat(32), position: 1 }],
    codes: [{ node: 'a1'.repeat(32) }], alternates: [], noShows: ['a4'.repeat(32)], federation: false, void: false };
  const nodes = [
    { node: 'a1'.repeat(32), base: 'https://a1', guardianCapable: true, guardianOf: [], bondSats: '200000', version: ok,
      found: { ok: true, body: { ...run, ready: { guardian: 'setup', cohort: { height: 157298, free: 13, needed: 10, nodes: ['a1'.repeat(32)] }, why: null } } } },
    { node: 'a2'.repeat(32), base: 'https://a2', guardianCapable: true, guardianOf: [], bondSats: '200000', version: ok,
      found: { ok: true, body: { ...run, codes: [], ready: { guardian: 'none', cohort: { height: 157297, free: 13, needed: 10 }, why: null } } } },
    { node: 'a3'.repeat(32), base: 'https://a3', guardianCapable: true, guardianOf: ['bb'.repeat(32)], bondSats: '200000', version: ok },   // guards an OPEN one
    { node: 'a4'.repeat(32), base: 'https://a4', guardianCapable: true, guardianOf: ['cc'.repeat(32)], bondSats: '90000', version: { ok: false } },   // CLOSED: free
    { node: 'a5'.repeat(32), base: 'https://a5', guardianCapable: false, guardianOf: [], version: ok },
  ];
  paint(nodes, [{ federation: 'bb'.repeat(32), status: 'OPEN' }, { federation: 'cc'.repeat(32), status: 'CLOSED' }]);
  const facts = drawn.find((d) => d[0] === '#founding-facts')[2].items;
  assert.deepEqual(facts.map((f) => f[1]), ['13 of 10 needed', '1 of 3', 'f0f0f0f0 · 1 of 2 codes · window to 157,302']);
  const t = drawn.find((d) => d[0] === 'founding')[2];
  assert.deepEqual(t.rows.map((r) => r.cells[4].t), ['counted ✓', 'not counted', 'not counted'], 'the newest cohort names a1 only');
  assert.deepEqual(t.rows.map((r) => [r.cells[0].t, r.cells[3].t, typeof r.cells[5] === 'string' ? r.cells[5] : r.cells[5].t]),
    [['a1a1a1a1a1a1', 'ready', 'seated 1 · code ✓'], ['a2a2a2a2a2a2', 'no guardian in setup', 'seated 2 · no code'], ['a4a4a4a4a4a4', 'not answering', 'no-show']]);
  assert.match(t.foot, /157,298: 13 free operators/);
});
