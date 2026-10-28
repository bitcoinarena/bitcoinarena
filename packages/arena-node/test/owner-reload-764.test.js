// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RELOAD KEEPS THE NODE (kanban #764, the owner: "Refresh on the logged-in owner page loses the login" - after a reload the site's
// owner page said "Open this page from your node's dashboard or the installer: it needs your node's key."). The area's menu links are
// #section anchors; each replaced the whole #, node= with it. Measured here on owner.html's own lines: the # the page moves to keeps the
// node, a reload reads it, and a # typed by hand in the same tab gets it back from the tab's memory. Nothing secret is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const KEEP = HTML.slice(HTML.indexOf('const NODE_PARTS'), HTML.indexOf('\nconst HASH'));
const KEY = 'ab'.repeat(32), LOCAL = 'http://127.0.0.1:18770';

// one page load of the site's owner page in a browser tab: the lines run with that tab's address, history and sessionStorage
function load(tab) {
  const listeners = [];
  const location = { pathname: '/owner/', search: '', get hash() { return tab.hash ? '#' + tab.hash : ''; } };
  const history = { state: null, replaceState: (_s, _t, url) => { tab.hash = url.split('#')[1] || ''; tab.replaced++; } };
  const sessionStorage = { getItem: (k) => tab.session[k] ?? null, setItem: (k, v) => { tab.session[k] = String(v); } };
  new Function('ON_SITE', 'location', 'history', 'sessionStorage', 'addEventListener', KEEP)(true, location, history, sessionStorage, (ev, f) => listeners.push([ev, f]));
  return {
    // a click on <a href="#roles">: the # replaced, then hashchange
    go(raw) { tab.hash = raw; for (const [ev, f] of listeners) if (ev === 'hashchange') f(); },
    // what the page's start reads: the node key, and the section OwnerArea.fromHash picks
    read() { const h = new URLSearchParams(tab.hash); return { node: h.get('node'), local: h.get('local'), section: h.get('section') }; },
  };
}

test('a menu click keeps node= in the #, and a reload finds the same node on the same section', () => {
  const tab = { hash: `node=${KEY}&local=${encodeURIComponent(LOCAL)}`, session: {}, replaced: 0 };
  const page = load(tab);
  assert.equal(tab.replaced, 0, 'a # with the node is left as it is');
  page.go('roles');
  assert.deepEqual(page.read(), { node: KEY, local: LOCAL, section: 'roles' });
  page.go('services');
  assert.deepEqual(page.read(), { node: KEY, local: LOCAL, section: 'services' });
  // the reload: the address bar as it is now
  const again = load(tab);
  assert.deepEqual(again.read(), { node: KEY, local: LOCAL, section: 'services' });
});

test('a # without the node in the same tab (typed, or an old link) gets the node back from the tab; a new tab without one does not', () => {
  const tab = { hash: `node=${KEY}&local=${encodeURIComponent(LOCAL)}&section=bond`, session: {}, replaced: 0 };
  load(tab);
  tab.hash = 'release';
  assert.deepEqual(load(tab).read(), { node: KEY, local: LOCAL, section: 'release' });
  const fresh = { hash: 'release', session: {}, replaced: 0 };
  assert.deepEqual(load(fresh).read(), { node: null, local: null, section: null });
  assert.equal(fresh.replaced, 0);
  // another node named in the # wins over the one the tab remembers
  const other = 'cd'.repeat(32);
  tab.hash = `node=${other}`;
  load(tab);
  tab.hash = 'roles';
  assert.equal(load(tab).read().node, other);
});

test('only the node\'s public part is kept: node, local, url - no owner secret, not the handoff', () => {
  const tab = { hash: `node=${KEY}&local=${encodeURIComponent(LOCAL)}&owner-handoff=1`, session: {}, replaced: 0 };
  load(tab);
  assert.deepEqual(Object.keys(JSON.parse(tab.session['arena-owner-node'])), ['node', 'local']);
  assert.doesNotMatch(KEEP, /localStorage|seed|nsec/);
});
