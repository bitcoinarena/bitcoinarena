// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// VERSION 4'S CLIENT (kanban #564, #523): the file in the tree is what its tool writes from version 3 and the table's bundle; its round
// logic is version 3's line for line (the code with the comments taken out the same way); only the drawing and the page's names
// changed; no name, ticket number or old project name is left; it seats players as version 3 does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildV4, FORBIDDEN, trailing } from '../tools/build-client-v4.mjs';

const V3 = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const V4 = readFileSync(new URL('../client/index-v4.html', import.meta.url), 'utf8');
const BUNDLE = new URL('../../arena-web/dist/rps.js', import.meta.url);
/** v3's code as the tool strips it: no comment lines, no trailing comments. */
const bare = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).map(trailing).join('\n').replace(/\/\* [^*]*\*\//g, '');
const part = (s, from, to) => { const a = s.indexOf(from); const b = s.indexOf(to, a); assert.ok(a > 0 && b > a, `${from} ... ${to}`); return s.slice(a, b); };

test('the file is what the tool writes (when the table bundle is built here)', { skip: !existsSync(BUNDLE) && 'packages/arena-web not built' }, () => {
  assert.equal(buildV4(V3, readFileSync(BUNDLE, 'utf8')), V4, 'client/index-v4.html is out of date: run tools/build-client-v4.mjs');
});

test('the round logic is version 3\'s line for line: the seating, the reads, the taps\' landing, paint', () => {
  for (const [from, to] of [['function seatAt(', '// SEATING END'], ['const refresh = async () => {', 'const TAPS = window.RPS_TAPS'],
    ['const settleTap = () => {', '    let touching = 0;'], ['const paint = () => {', '    const tickDue = () => {']]) {
    const v3 = bare(part(V3, from, to)).replace(/window\.parent\.BLWP_/g, 'window.parent.ARENA_');
    assert.equal(part(V4, from, to), v3, from);
  }
});

test('only the drawing changed: draw hands the state to the React table, tap marks no button itself', () => {
  assert.match(V4, /const table = window\.RpsView\.mount\(\$\('view'\), \{ onTap: \(id, i, closeMs\) => tap\(id, i, closeMs\) \}\);/);
  assert.match(part(V4, 'const draw = (s) => {', '    const DEMO'), /table\.draw\(s, \{ stage, stageFailed \}\);/);
  assert.doesNotMatch(V4, /g\.querySelectorAll\('button'\)|b\.classList\.add\('chosen'\)/);
  assert.match(V4, /const tap = async \(id, i, closeMs\) => \{/);
  assert.ok(V4.indexOf('window.RpsView={mount') > 0 || /window\.RpsView\s*=\s*\{\s*mount/.test(V4), 'the table is inlined: nothing is fetched');
  assert.ok(V4.indexOf('RpsView') < V4.indexOf('const A = window.parent && window.parent.ARENA_GAME;'), 'before the round\'s script');
});

test('no name, ticket number or old project name is left; the page\'s ARENA_ names are used', () => {
  const left = V4.split('\n').filter((l) => FORBIDDEN.test(l));
  assert.deepEqual(left.map((l) => l.trim().slice(0, 60)), []);
  assert.match(V4, /window\.parent\.ARENA_ROW_NODES/); assert.match(V4, /window\.parent\.ARENA_JOIN_ANSWER/); assert.match(V4, /window\.parent\.ARENA_JOIN;/);
  assert.match(V3, /kanban #\d+/, 'version 3 keeps its history');
});

test('it seats as version 3 does', () => {
  const seat = (html) => new Function(html.slice(html.indexOf('// SEATING BEGIN'), html.indexOf('// SEATING END')) + '\nreturn seatAt;')();
  const [s3, s4] = [seat(V3), seat(V4)];
  const id = (n) => n.toString(16).padStart(64, '0');
  const slot = [{ id: id(1), joined: 1 }, { id: id(2), joined: 0 }, { id: id(3), joined: 2 }];
  for (const args of [[slot, {}], [slot, { prevSlot: [{ id: id(9), joined: 2 }], mineId: id(9) }], [[], {}], [slot.map((x) => ({ ...x, open: false })), {}]])
    assert.deepEqual(s4(...args), s3(...args));
  assert.equal(s4(slot, {}).id, id(1), 'where one player waits first');
});
