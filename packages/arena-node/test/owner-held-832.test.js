// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NOTHING IS WRITTEN BEFORE THE NODE TAKES THE KEY (kanban #832): the page's own lines, run with a fake localStorage - the way in only holds a
// secret; it reaches the browser's storage at keepHeld(), which area() calls after the node has taken the login, and start() drops a refused one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const code = HTML.slice(HTML.indexOf('let held = null;'), HTML.indexOf('let state = null, me = null;'));
function page(refuse = false) {
  const store = new Map(), localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { if (refuse) throw new Error('denied'); store.set(k, v); }, removeItem: (k) => store.delete(k) };
  const C = { toHex: (b) => Buffer.from(b).toString('hex'), fromHex: (h) => Buffer.from(h, 'hex') };
  const fns = new Function('C', 'localStorage', 'STORE', 'NSTORE', 'start', `let me = null;\n${code.replace(/^const NSTORE = .*$/m, '')}\nreturn { readSeed, readNostr, holdSeed, holdNostr, keepHeld, forget, held: () => held };`)(C, localStorage, 'seed', 'nostr', () => {});
  return { ...fns, store };
}

test('a held seed is read back but written nowhere until keepHeld, and then only once', () => {
  const p = page(), seed = Buffer.alloc(32, 7);
  p.holdSeed(seed);
  assert.equal(p.store.size, 0, 'nothing in the browser yet');
  assert.deepEqual(p.readSeed(), seed);
  assert.equal(p.readNostr(), null);
  assert.equal(p.keepHeld(), true);
  assert.deepEqual([...p.store], [['seed', seed.toString('hex')]]);
  assert.equal(p.held(), null, 'nothing left in memory');
  assert.equal(p.readSeed().toString('hex'), seed.toString('hex'));
});

test('a held Nostr login the same way, and sign-out drops a held key and a kept one', () => {
  const p = page(), login = { how: 'nsec', secret: '22'.repeat(32) };
  p.holdNostr(login);
  assert.equal(p.store.size, 0);
  assert.deepEqual(p.readNostr(), login);
  assert.equal(p.readSeed(), null);
  p.keepHeld();
  assert.deepEqual(JSON.parse(p.store.get('nostr')), login);
  p.holdSeed(Buffer.alloc(32, 1));
  p.forget();
  assert.deepEqual([p.store.size, p.held()], [0, null]);
});

test('a browser that keeps nothing: keepHeld says so and the key stays held for this tab', () => {
  const p = page(true), seed = Buffer.alloc(32, 9);
  p.holdSeed(seed);
  assert.equal(p.keepHeld(), false);
  assert.deepEqual(p.readSeed(), seed);
});

test('the page keeps only after the login, and drops a refused key in start()', () => {
  const area = HTML.slice(HTML.indexOf('async function area()'), HTML.indexOf('const who = await identity();'));
  assert.ok(area.indexOf("post('/owner/login'") < area.indexOf('keepHeld()'), 'keepHeld comes after the node took the login');
  const refused = HTML.slice(HTML.indexOf('if (state.owner !== mine) {'), HTML.indexOf('return area();'));
  assert.match(refused, /held = null; me = null;/);
  assert.match(refused, /Nothing was kept in this browser/);
  const writes = HTML.split('\n').filter((l) => /localStorage\.setItem/.test(l));
  assert.deepEqual(writes.filter((l) => !/d\.seed|d\.secret|k\.seed|k\.secret|held\.seed/.test(l)), [], 'every write is the installer hand-over or keepHeld');
});
