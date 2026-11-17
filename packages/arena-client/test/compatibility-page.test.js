// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTED SIGNERS AND WALLETS PAGE (kanban #2917): bitcoinarena.io/compatibility/ lists only products that WORK, grouped into
// Log in and Pay and withdraw, and the products still to test under "Next to test"; the data is the page's results.json and planned.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DIR = new URL('../../../src/website/www/compatibility/', import.meta.url);
const SCRIPT = readFileSync(new URL('list.js', DIR), 'utf8');
const HTML = readFileSync(new URL('index.html', DIR), 'utf8');
const RESULTS = JSON.parse(readFileSync(new URL('results.json', DIR), 'utf8'));
const PLANNED = JSON.parse(readFileSync(new URL('planned.json', DIR), 'utf8'));

function load() {
  const window = {};
  vm.runInNewContext(SCRIPT, { window, Promise, Object, Array, JSON });
  return window.ARENA_COMPAT;
}

/** A small DOM: enough for draw() - elements with children, text, class, href. */
function fakeDoc() {
  const make = (tag) => ({ tag, children: [], className: '', textContent: '', href: '', rel: '', appendChild(c) { this.children.push(c); return c; } });
  const boxes = { login: make('div'), pay: make('div'), next: make('div') };
  const root = { querySelector: (q) => boxes[(q.match(/data-group="(\w+)"/) || [])[1]] || null };
  return { doc: { createElement: make }, root, boxes };
}
const text = (n) => n.textContent + n.children.map(text).join(' ');
const row = (o) => ({ name: 'X', version: '1', kind: 'Browser extension', date: '2026-11-17', how: 'manual', checks: { login: 'ok' }, result: 'works', ...o });

test('only working rows with something checked are listed; problems and empty checks are not', () => {
  const C = load();
  const d = C.sections([row({ name: 'Good' }), row({ name: 'Bad', result: 'problems', checks: { login: 'no answer' } }), row({ name: 'Empty', checks: {} })], []);
  assert.deepEqual(d.groups.find((g) => g.id === 'login').rows.map((r) => r.name), ['Good']);
});

test('signers go under Log in, NWC wallets under Pay and withdraw, each with its NIP', () => {
  const C = load();
  const d = C.sections([row({ name: 'Ext' }), row({ name: 'Phone', kind: 'Remote signer' }), row({ name: 'Wal', kind: 'NWC wallet', how: 'automatic', checks: { get_balance: 'ok', pay_invoice: 'ok' } })], []);
  const g = Object.fromEntries(d.groups.map((x) => [x.id, x.rows.map((r) => `${r.name} ${r.nip}`)]));
  assert.deepEqual(g, { login: ['Ext NIP-07', 'Phone NIP-46'], pay: ['Wal NIP-47'] });
  assert.equal(d.groups[1].rows[0].checked, 'Automatic run: balance read, deposit paid.');
});

test('a planned product that now works leaves "Next to test"; one with problems stays there', () => {
  const C = load();
  const d = C.sections([row({ name: 'A' }), row({ name: 'B', result: 'problems' })], [{ name: 'A', kind: 'Browser extension' }, { name: 'B', kind: 'Browser extension' }, { name: 'C', kind: 'NWC wallet' }]);
  assert.deepEqual(d.next.map((p) => p.name), ['B', 'C']);
});

test('the page draws names as text, links only https addresses, and says when a group is empty', () => {
  const C = load();
  const { doc, root, boxes } = fakeDoc();
  C.draw(root, doc, C.sections([row({ name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }), row({ name: 'Linked', url: 'https://example.com/' })], [{ name: 'Later', kind: 'NWC wallet' }]));
  const cards = boxes.login.children;
  assert.equal(cards.length, 2);
  const first = cards.find((c) => text(c).includes('<img'));
  assert.equal(first.children[0].children[0].tag, 'b', 'a non-https address is not a link');
  const linked = cards.find((c) => text(c).includes('Linked')).children[0].children[0];
  assert.deepEqual([linked.tag, linked.href, linked.rel], ['a', 'https://example.com/', 'noopener']);
  assert.match(text(boxes.pay), /None tested yet/);
  assert.match(text(boxes.next), /Later.*Not tested yet/);
});

test('the shipped data supports manual and automatic results as the tested catalog grows (kanban #2955)', () => {
  const C = load();
  const d = C.sections(RESULTS, PLANNED);
  for (const name of ['Amber', 'Clave', 'nos2x', 'Sidecar']) assert.ok(d.groups[0].rows.some((r) => r.name === name), name);
  for (const r of RESULTS) {
    assert.ok(['manual', 'automatic'].includes(r.how), r.name);
    assert.equal(r.result, 'works', r.name);
    assert.ok(Object.keys(r.checks || {}).length > 0, r.name);
    assert.ok(Object.values(r.checks).every((c) => c === 'ok'), r.name);
  }
  for (const p of PLANNED) {
    assert.ok(['Browser extension', 'Remote signer', 'NWC wallet'].includes(p.kind), p.name);
    assert.match(p.url, /^https:\/\//, p.name);
  }
  const listed = [...d.next, ...d.groups.flatMap((g) => g.rows)];
  for (const p of PLANNED) assert.equal(listed.filter((r) => r.name === p.name && r.kind === p.kind).length, 1, p.name + ' appears once, working or next to test');
});

test('the page loads list.js and has the three groups; the old hard-coded table is gone', () => {
  assert.match(HTML, /<script src="list\.js"><\/script>/);
  for (const g of ['login', 'pay', 'next']) assert.match(HTML, new RegExp(`data-group="${g}"`));
  assert.ok(!HTML.includes('<table id="rows">') && !HTML.includes('var waiting'));
});
