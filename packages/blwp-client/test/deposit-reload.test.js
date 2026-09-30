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
