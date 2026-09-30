// A RELOAD OF THE DEPOSIT PAGE LANDS ON THE LOBBY (the owner 2026-09-30 21:10, PRIORITIES): the page's boot lines, run on
// a fake tab - the address the deposit offer noted goes back to the lobby behind it; any other address stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
const from = html.indexOf('// A RELOAD OF THE DEPOSIT PAGE LANDS ON THE LOBBY');
const to = html.indexOf("const boot = document.getElementById('boot');", from);
const boot = html.slice(from, to);

function load(search, noted) {
  const kept = new Map(noted ? [['blwp.depositAt', JSON.stringify(noted)]] : []);
  const sessionStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), removeItem: (k) => kept.delete(k) };
  const location = { pathname: '/', search };
  const history = { replaceState: (_s, _t, url) => { const i = url.indexOf('?'); location.search = i < 0 ? '' : url.slice(i); } };
  new Function('sessionStorage', 'location', 'history', boot)(sessionStorage, location, history);
  return { search: location.search, kept };
}

test('the boot lines are in the page, before the boot element is read', () => {
  assert.ok(from > 0 && to > from);
  assert.match(html, /sessionStorage\.setItem\('blwp\.depositAt'/, 'the join deposit offer notes its address');
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

// TYPING IN THE PAGE'S OWN FIELDS (the owner 2026-09-30 22:04): the guard is registered on the window, in the capture phase,
// before Unity's keyboard capture; a key in an input stops there (Unity's later listener never runs), one on the canvas
// goes on.
test('a key typed into a field never reaches a later window listener (Unity), a key on the canvas does', () => {
  const from2 = html.indexOf('// TYPING IN THE PAGE\'S OWN FIELDS');
  const code = html.slice(html.indexOf('(function () {', from2), html.indexOf('})();', from2) + 5);
  const listeners = [];
  const window = { addEventListener: (n, fn, capture) => listeners.push({ n, fn, capture }) };
  new Function('window', code)(window);
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
