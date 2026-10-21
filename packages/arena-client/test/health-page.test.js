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

test('the Capacity card: each federation\'s band in words, who is below B* and by how much, and the network with the install minimum', async () => {
  // spec §23A.3a, kanban #543: from the seats' GET /capacity (capacityView, arena-protocol)
  const { capacityView } = await import('../../arena-protocol/src/capacity.js');
  const view = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, federations: [
    { federation: 'aa'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '130000', exposureCapSats: '150000',
      guardianBonds: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ node: String(i), bondSats: 50000n })), gateways: [{ node: '1', pegInSats: 20000n }] },
    { federation: 'bb'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '650000', exposureCapSats: '150000', guardianBonds: [], gateways: [] },
    { federation: 'cc'.repeat(32), status: 'OPEN', nominal: 7, reserveSats: '10000', exposureCapSats: '150000', guardianBonds: [], gateways: [] }] });
  const at = script.indexOf('  function paintCapacity(cap, feds = []) {');
  const src = script.slice(at, script.indexOf('\n  }\n', at) + 4);
  const el = { innerHTML: '' }; const window = {};
  const esc = (x) => String(x == null ? '' : x); const short = (h, n = 8) => String(h).slice(0, n);
  const sat = (v) => Number(v).toLocaleString('en-US'); const dot = (c) => `[${c}]`;
  new Function('$', 'esc', 'short', 'sat', 'dot', 'window', 'fedNoOf', 'H', src + '\nreturn paintCapacity;')(() => el, esc, short, sat, dot, window, () => null, null)({ body: view });
  assert.match(el.innerHTML, /\[warn\]<b>PRESSURE<\/b> · filling up · OPEN - Federation aaaaaaaa holds 87 % of what its bonds cover\. Deposits stop at 100 %\. 7 of 7 guardians below the bond B\* = 86,667 sat - increase your bond by 36,667 sat \(Add to bond\)\. 1 gateway\(s\) below the peg-in P\* = 50,000 sat\./);
  assert.match(el.innerHTML, /\[bad\]<b>FULL<\/b> · deposits closed · OPEN - Deposits into bbbbbbbb are closed until bonds rise or a new federation is founded\./);
  // kanban #553: a federation that takes no deposits (draining into its successor) has no band and no plea, its status and successor said
  const drain = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, federations: [{ federation: 'dd'.repeat(32), status: 'CRITICAL', nominal: 7, reserveSats: '108000', exposureCapSats: '150000',
    guardianBonds: [1, 2, 3].map((i) => ({ node: String(i), bondSats: 50000n })), gateways: [] }] });
  assert.deepEqual([drain.federations[0].band, drain.federations[0].guardiansBelowTarget.length], ['NOT_OPEN', 0]);
  const el2 = { innerHTML: '' };
  new Function('$', 'esc', 'short', 'sat', 'dot', 'window', 'fedNoOf', 'H', src + '\nreturn paintCapacity;')(() => el2, esc, short, sat, dot, window, (f) => ({ ['dd'.repeat(32)]: 2, ['ee'.repeat(32)]: 3 })[f] || null, null)({ body: drain }, [{ federation: 'dd'.repeat(32), successor: 'ee'.repeat(32) }]);
  assert.match(el2.innerHTML, /\[muted\]<b>CRITICAL<\/b> · takes no deposits - Federation 2 is draining into Federation 3: new deposits and rounds go there\./);
  assert.doesNotMatch(el2.innerHTML, /increase your bond/);
  assert.match(el.innerHTML, /\[ok\]<b>CALM<\/b> · room left · OPEN - Federation cccccccc: 7 % of what its bonds cover\./);
  assert.match(el.innerHTML, /<b>Network: CALM<\/b> - the lowest-load OPEN federation cccccccc at 7 % · new installs bond at least 180,000 sat/);
  const none = { innerHTML: '' };
  new Function('$', 'esc', 'short', 'sat', 'dot', 'window', 'H', src + '\nreturn paintCapacity;')(() => none, esc, short, sat, dot, {}, null)(null);
  assert.match(none.innerHTML, /no seat answers \/capacity yet/);
});
