// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RELOAD OF THE DEPOSIT PAGE LANDS ON THE LOBBY (2026-09-30 21:10, PRIORITIES): the page's boot lines, run on
// a fake tab - the address the deposit offer noted goes back to the lobby behind it; any other address stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the run's end is Tick Tock's page part (kanban #521)
const UNITY_PAGE = new URL('../../nextblock/page/unity-page.js', import.meta.url);
const unity = readFileSync(UNITY_PAGE, 'utf8');
const from = html.indexOf('// A RELOAD OF THE DEPOSIT PAGE LANDS ON THE LOBBY');
const to = html.indexOf("const boot = document.getElementById('boot');", from);
const boot = html.slice(from, to);

function load(search, noted) {
  const kept = new Map(noted ? [['arena.depositAt', JSON.stringify(noted)]] : []);
  const sessionStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), removeItem: (k) => kept.delete(k) };
  const location = { pathname: '/', search };
  const history = { replaceState: (_s, _t, url) => { const i = url.indexOf('?'); location.search = i < 0 ? '' : url.slice(i); } };
  pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['sessionStorage', 'location', 'history'], boot)(sessionStorage, location, history);
  return { search: location.search, kept };
}

test('the boot lines are in the page, before the boot element is read', () => {
  assert.ok(from > 0 && to > from);
  assert.match(html, /sessionStorage\.setItem\('arena\.depositAt'/, 'the join deposit offer notes its address');
});

test('a reload of the noted deposit address goes to the lobby behind it, once', () => {
  const at = '?round=ab12&node=https://n1&play=1';
  let r = load(at, { at, back: '?node=https://n1&bond=x' });
  assert.equal(r.search, '?node=https://n1&bond=x');
  assert.equal(r.kept.size, 0, 'the note is used once');
  r = load(at, { at, back: '' });
  assert.equal(r.search, '', 'no lobby link behind it: the bare root (the daily.json lobby)');
});

test('any other address stays: a round link with no deposit up, and a different round', () => {
  assert.equal(load('?round=ab12&play=1', null).search, '?round=ab12&play=1');
  assert.equal(load('?round=cd34&play=1', { at: '?round=ab12&play=1', back: '' }).search, '?round=cd34&play=1');
});

// TYPING IN THE PAGE'S OWN FIELDS (2026-09-30 22:04): the guard is registered on the window, in the capture phase,
// before Unity's keyboard capture; a key in an input stops there (Unity's later listener never runs), one on the canvas
// goes on.
test('a key typed into a field never reaches a later window listener (Unity), a key on the canvas does', () => {
  const from2 = html.indexOf('// TYPING IN THE PAGE\'S OWN FIELDS');
  const code = html.slice(html.indexOf('(function () {', from2), html.indexOf('})();', from2) + 5);
  const listeners = [];
  const window = { addEventListener: (n, fn, capture) => listeners.push({ n, fn, capture }) };
  pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['window'], code)(window);
  assert.deepEqual(listeners.map((l) => [l.n, l.capture]), [['keydown', true], ['keypress', true], ['keyup', true]]);
  let unity = 0;
  listeners.push({ n: 'keydown', fn: () => { unity++; }, capture: true });   // Unity, registered after the page's guard
  const fire = (target) => {
    let stopped = false;
    const e = { target, stopImmediatePropagation: () => { stopped = true; } };
    for (const l of listeners.filter((x) => x.n === 'keydown')) { if (stopped) break; l.fn(e); }
  };
  fire({ tagName: 'INPUT' }); fire({ tagName: 'TEXTAREA' });
  assert.equal(unity, 0, 'Unity took a key typed into a field');
  fire({ tagName: 'CANVAS' });
  assert.equal(unity, 1, 'a key on the game no longer reached Unity');
});

// A RELOAD AFTER THE ROUND STARTED BEGINS NO FUNDING (2026-10-03, "That run must not be lost"): the page's join
// starts a deposit only for a lock it must make anew, asks keptLockUse with the round's close, and a resumed run
// ('running') is named to the bridge - never a second deposit.
test('a reload after the start: no funding unless the kept lock answers new, the close is asked, a running resume is named to the bridge', async () => {
  const { keptLockUse } = await import('../src/page-lock.js');
  assert.match(html, /if \(keptUseOf\(keptEarly\)\.use === 'new'\) funding = /, 'funding starts only for a lock made anew');
  assert.match(html, /beforeClose: Date\.now\(\) < closeMsOf\(\)/, 'the round\'s close bounds the resume');
  assert.match(html, /if \(use\.resumed === 'running'\) \{\s*window\.ARENA_RESUME = \{ roundIdHex: named\.roundIdHex, entryIdHex: String\(use\.kept\.committedTo\)/);
  // a committed lock with no kept entry, running: staked - and staked is not 'new', so no funding either
  const kept = { committedTo: 'ee'.repeat(32) };
  assert.notEqual(keptLockUse(kept, { entry: null, beforeStart: false, beforeClose: true }).use, 'new');
  assert.notEqual(keptLockUse(kept, { entry: null, beforeStart: false, beforeClose: false }).use, 'new');
});

// AND ITS ADDRESS STAYS WHILE IT CATCHES UP: the run-end handler, run on a fake tab.
test('the run-end handler leaves a resumed round\'s address until that run ends, or its round closes', () => {
  const a = unity.indexOf('    window.ARENA_RUN_OVER = (word, run) => {');
  const b = unity.indexOf('      window.ARENA_RUN_ENDED = String(word || \'\');', a);
  assert.ok(a > 0 && b > a);
  const body = unity.slice(a, b).replace('    window.ARENA_RUN_OVER = (word, run) => {', '');
  const runOver = (win, run) => {
    const location = { pathname: '/', search: '?round=aa&play=1' };
    const history = { replaceState: (_s, _t, url) => { const i = url.indexOf('?'); location.search = i < 0 ? '' : url.slice(i); } };
    pageFunction(UNITY_PAGE, ['window', 'location', 'history', 'prefetchReplayNodes', 'URLSearchParams', 'word', 'run'], body)(
      win, location, history, () => {}, URLSearchParams, 'FINISHED', run);
    return location.search;
  };
  const later = Date.now() + 60000;
  assert.equal(runOver({ ARENA_RESUME: { roundIdHex: 'aa', caughtUp: false, closeMs: later } }, null), '?round=aa&play=1', 'catching up: stays');
  assert.equal(runOver({ ARENA_RESUME: { roundIdHex: 'aa', caughtUp: true, closeMs: later } }, { roundHex: 'bb' }), '?round=aa&play=1', 'another run\'s end: stays');
  const w = { ARENA_RESUME: { roundIdHex: 'aa', caughtUp: true, closeMs: later } };
  assert.equal(runOver(w, { roundHex: 'aa' }), '', 'the resumed run itself ended: the lobby\'s address');
  assert.equal(w.ARENA_RESUME, null, 'and the resume is over');
  assert.equal(runOver({ ARENA_RESUME: { roundIdHex: 'aa', caughtUp: false, closeMs: Date.now() - 1 } }, null), '', 'its round closed');
});
