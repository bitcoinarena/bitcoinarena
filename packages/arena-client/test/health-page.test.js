// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE ASKS ONLY PUBLIC DOORS (kanban #526): every path src/arena-ui/health/index.html asks a node is a GET the
// nodes document as needing no authentication (src/website/docs/endpoints.json), the page's script parses, and it never asks more than
// six requests at once with a time limit on each. The read is src/arena-ui/health/network.js since kanban #686 (the page and the explorer's
// copy run it), and the page draws a kept copy first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/health/index.html', import.meta.url), 'utf8');
const ENDPOINTS = JSON.parse(readFileSync(new URL('../../../src/website/docs/endpoints.json', import.meta.url), 'utf8'));
const page = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
const NETWORK = new URL('../../../src/arena-ui/health/network.js', import.meta.url);
const script = readFileSync(NETWORK, 'utf8');

test('the health page asks the nodes only public GET doors the API reference lists', () => {
  const asked = new Set();
  for (const m of script.matchAll(/['`](\/[a-z][a-z0-9./-]*)(?:\?[^'`]*)?['`]/g)) asked.add(m[1]);
  assert.ok(asked.size >= 10, `too few paths read off the page: ${[...asked]}`);
  const open = new Set(ENDPOINTS.filter((e) => e.method === 'GET' && e.auth === 'none' || e.method === 'GET' && String(e.auth).startsWith('none'))
    .flatMap((e) => String(e.path).split(/\s+\(also\s+|\)/).map((p) => p.trim()).filter((p) => p.startsWith('/'))));
  const unknown = [...asked].filter((p) => !open.has(p));
  assert.deepEqual(unknown, [], 'asked but not a public GET in endpoints.json');
});

test('the page script parses, and the read limits itself: six at once, 10 s each; the nodes asked when the copy is 5 min old, looked at every 60 s', () => {
  assert.doesNotThrow(() => new Function(page));
  assert.match(script, /export const ASK_MS = 10000, AT_ONCE = 6;/);
  assert.match(script, /signal: AbortSignal\.timeout\(ASK_MS\)/);
  assert.match(page, /STALE_MS = 5 \* 60000, EVERY_MS = 60000/);
  assert.match(page, /setInterval\(\(\) => run\(tick\), EVERY_MS\)/);
  assert.match(page, /COPY_URL = 'https:\/\/explorer\.bitcoin-arena\.io\/api\/health'/);
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
  const spare = new Set();
  const fn = new Function('ask', 'drawTable', 'fedCell', 'cut', 'sat', 'spare', 'keyOf', src + '\nreturn paintGateways;')(ask, (id, head, rows, empty, foot) => { tables[id] = { head, rows, empty, foot }; },
    (f) => String(f).slice(0, 12), (x, n) => String(x).slice(0, n), (x) => Number(x).toLocaleString('en-US'), spare, (b, p) => b + p);
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

test('Waiting for a founding: one list from one seat, and every number counted from its rows (kanban #585, Alice: "Wenn 8 von 10 ready sind müssen auch 8 da stehen")', () => {
  const at = script.indexOf('  function paintFounding(nodes, feds, mem) {');
  const src = script.slice(at, script.indexOf('\n  }\n', at) + 4);
  const drawn = [];
  const H = { draw: (el, kind, props) => drawn.push([el, kind, props]) };
  const sat = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-US'));
  const cut = (h, n = 8) => (h ? String(h).slice(0, n) : '-');
  const drawTable = (id, head, rows, empty, foot) => drawn.push([id, 'table', { head, rows, empty, foot }]);
  const paint = new Function('$', 'H', 'sat', 'cut', 'drawTable', src + '\nreturn paintFounding;')((id) => '#' + id, H, sat, cut, drawTable);
  const K = (i) => String(i).padStart(2, '0').repeat(32);
  // ten drawn, eight with their code; two more that can be drawn; the seat asked all twelve
  const run = { id: 'f0'.repeat(32), windowEnd: 157308, trigger: { height: 157302 }, seated: Array.from({ length: 10 }, (_, i) => ({ node: K(i), position: i })),
    codes: Array.from({ length: 8 }, (_, i) => ({ node: K(i) })), alternates: [K(10)], noShows: [], federation: false, void: false };
  const mem = { height: 157307, free: 20, needed: 10, nodes: Array.from({ length: 12 }, (_, i) => ({ node: K(i), endpoint: `https://n${i}`, state: i < 8 ? 'setup' : i === 8 ? 'off' : i === 9 ? 'no answer' : 'setup' })) };
  // an older draw on a node not restarted yet, with more codes: not the one shown
  const nodes = [{ found: { ok: true, body: run } }, { found: { ok: true, body: run } }, { found: { ok: true, body: { ...run, id: 'e0'.repeat(32), codes: Array.from({ length: 9 }, (_, i) => ({ node: K(i) })) } } }];
  paint(nodes, [], mem);
  const facts = drawn.find((d) => d[0] === '#founding-facts')[2].items.map((f) => f[1]);
  const t = drawn.find((d) => d[0] === 'founding')[2];
  assert.deepEqual(facts, ['12 nodes (20 operators, 10 needed)', '10 of 12', 'f0f0f0f0: 10 drawn, 8 posted their code · until block 157,308']);
  assert.equal(t.rows.length, 12, 'as many rows as "can be drawn" says');
  assert.equal(t.rows.filter((r) => r.cells[2].t === 'ready').length, 10, 'as many "ready" rows as the count says');
  assert.equal(t.rows.filter((r) => /code ✓/.test(r.cells[3].t || '')).length, 8, 'as many "code ✓" rows as "posted their code"');
  assert.deepEqual(t.rows.slice(0, 10).map((r) => r.cells[3].t), [...Array(8).fill(0).map((_, i) => `drawn #${i + 1} · code ✓`), 'drawn #9 · no code yet', 'drawn #10 · no code yet'], 'the drawn first, in order');
  assert.deepEqual([t.rows[8].cells[2].t, t.rows[9].cells[2].t], ['founding is off on this node', 'no answer'], 'and why the two have no code');
  // no seat answered its list: nothing is guessed
  drawn.length = 0;
  paint([], [], null);
  assert.equal(drawn.find((d) => d[0] === '#founding-facts')[2].items[0][1], 'no seat answered its list yet');
  assert.deepEqual(drawn.find((d) => d[0] === 'founding')[2].rows, []);
});

test('a federation no seat names a reserve key for is temporarily unavailable, with the block and the time it returns (kanban #819)', async () => {
  const { unavailableFederations, unavailableLine } = await import('../../../src/arena-ui/health/network.js');
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), nowMs = Date.UTC(2026, 9, 30, 13, 0);
  const reserves = { federations: [{ federationId: A, key: null, reserveKey: null, why: 'no reserve key for 0 guardian seats' }, { federationId: B, key: null, reserveKey: `02${'cd'.repeat(32)}` }] };
  const m = unavailableFederations(reserves, { expected: { [A]: 158325 }, tip: 158235, nowMs });
  assert.deepEqual([...m.keys()], [A], 'a seat that is no member names the key as reserveKey: B stands');
  assert.equal(m.get(A).block, 158325);
  assert.equal(unavailableLine(4, A, m.get(A), nowMs), 'Federation 4 (aaaaaaaa) is temporarily unavailable: no reserve key yet, so paid rounds there are paused. Expected back from block 158,325, around 2026-10-31 04:00 UTC (in about 15 hours).');
  const none = unavailableFederations(reserves, { nowMs }).get(A);
  assert.match(unavailableLine(4, A, none, nowMs), /No return block is known yet\.$/);
  assert.equal(unavailableFederations(null).size, 0, 'no answer: nothing is called unavailable');
});
