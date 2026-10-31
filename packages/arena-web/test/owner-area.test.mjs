// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA IN REACT (kanban #564): the sidebar with a dot where a section needs the owner, one section shown; the Overview's list
// ("checking" until something said) and stat cards; every panel's place empty for the page; the emergency code shown only on a press (or
// why there is none); signing with the developer key (or why not); the login with the words shown, or signed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerArea, SECTIONS } from '../dist/test/owner-area.mjs';

const base = { node: 'ab'.repeat(32), owner: 'cd'.repeat(32), claimedAtMs: Date.UTC(2026, 9, 21), guardian: true, guardianUp: true, how: 'words',
  games: [{ name: 'nextblock', version: 5 }, { name: 'rock-paper-scissors', version: 4 }], emergencyCode: 'EMER-GENC-YCOD', emergencyLink: '/Dashboard/emergency',
  devKey: 'ef'.repeat(32), hasDevs: true, onShowWords: () => ['w1', 'w2'], onForget() {}, signManifest: () => ({ gameId: '12'.repeat(32), hex: 'beef' }) };
function area(props = {}) {
  const m = new OwnerArea({ ...base, ...props });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  return { m, html: () => renderToStaticMarkup(m.render()) };
}

// THE DASHBOARD'S "SET UP THE BOND" (kanban #728): the site's page at #node=...&section=bond opens the Bond section; #bond as before
test('a section named beside the node in the # opens it; a plain #section as before; anything else the Overview', () => {
  const was = globalThis.location;
  try {
    const at = (hash) => { globalThis.location = { hash }; return area().m.fromHash(); };
    assert.deepEqual([at(`#node=${'ab'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8770&section=bond`), at('#bond'), at(`#node=${'ab'.repeat(32)}`), at('#nope'), at('')],
      ['bond', 'bond', 'overview', 'overview', 'overview']);
  } finally { globalThis.location = was; }
});

test('the sidebar marks the sections that need the owner; one section shown; the Overview says "checking" until something said', () => {
  const a = area({ needs: null });
  const h = a.html();
  assert.equal((h.match(/<a href="#/g) || []).length, SECTIONS.length);
  assert.match(h, /<a href="#overview" data-s="overview" class="on">Overview<span class="dot" id="dot-overview"><\/span><\/a>/);
  assert.match(h, /<section id="s-overview"><h2>Overview<\/h2><div id="setup-place"><\/div><div class="card" id="needs"><p class="sub">checking this node…<\/p><\/div>/);
  assert.match(h, /<section id="s-roles" hidden="">/);
  assert.match(h, /<div class="stat is-ok"><span><i class="si" aria-hidden="true">◈<\/i>Custody<\/span><b class="ok">Guardian<\/b>/);
  assert.match(h, /<div class="stat is-ok"><span><i class="si" aria-hidden="true">▦<\/i>Apps<\/span><b>2<\/b><small>nextblock v5, rock-paper-scissors v4<\/small>/);
  assert.match(h, /<div class="stat"><span><i class="si" aria-hidden="true">◷<\/i>Owner since<\/span><b>2026-10-21<\/b><small>signed in with your 24 words<\/small>/);
  const n = area({ needs: [{ level: 'warn', text: 'A new release is out: 2026.1.2.', section: 'release' }, { level: 'bad', text: 'Your bond is too small.', section: 'bond' }] }).html();
  assert.match(n, /data-s="bond">Bond<span class="dot d-bad" id="dot-bond"><\/span>/);
  assert.match(n, /data-s="release">Updates<span class="dot d-warn" id="dot-release"><\/span>/);
  assert.match(n, /<h3>To do<\/h3><p class="err">🔴 Your bond is too small\. <a href="#bond">Open<\/a><\/p><p class="warnline">/);
  assert.match(area({ needs: [] }).html(), /All good ✓/);
});

// GREEN ONLY WHILE ITS GUARDIAN RUNS (the 2026.1.9.11 install test: "Custody: Guardian" in green while this node's fedimintd had ended at its start)
test('the Overview\'s Custody follows the Services card\'s guardian row: green while it runs, red when it does not, plain until it answered', () => {
  assert.match(area({ guardianUp: false }).html(), /<div class="stat is-bad"><span><i class="si" aria-hidden="true">◈<\/i>Custody<\/span><b class="bad">Guardian, not running<\/b><small><a href="#services">See Services<\/a><\/small>/);
  assert.match(area({ guardianUp: null }).html(), /<div class="stat"><span><i class="si" aria-hidden="true">◈<\/i>Custody<\/span><b>Guardian<\/b>/);
  assert.match(area({ guardian: false, guardianUp: false }).html(), /<div class="stat"><span><i class="si" aria-hidden="true">◈<\/i>Custody<\/span><b>No custody<\/b>/);
});

test('every panel\'s place is there and empty, for the page to draw into', () => {
  const h = area({ needs: null }).html();
  for (const id of ['roles', 'custody', 'liquidity', 'bond', 'standing', 'address', 'services', 'release', 'leave'])
    assert.match(h, new RegExp(`<div class="card" id="${id}"></div>`), id);
  // the Bond answer draws its own card, none when it has nothing to say (kanban #728, the 2026.1.9.11 install test: an empty box)
  for (const id of ['bond-answer', 'capacity-plea', 'installed', 'netfound', 'netmine', 'dons', 'devs', 'ballots']) assert.match(h, new RegExp(`<div id="${id}"></div>`), id);
});

test('the emergency code only on a press; none without the words', () => {
  const a = area();
  assert.match(a.html(), /<b id="emcode">hidden<\/b><\/div><button type="button" id="emshow">Show the code<\/button>/);
  a.m.setState({ emShown: true });
  assert.match(a.html(), /<b id="emcode">EMER-GENC-YCOD<\/b><\/div><p class="sub">The code only takes your node out/);
  assert.match(area({ emergencyCode: null }).html(), /You signed in without your 24 words or nsec, so this browser can.{1,6}t show the code\./);
});

test('signing a manifest with the developer key; the error said; no key with a Nostr signer', () => {
  const a = area();
  a.m.state.manifest = '{}'; a.m.sign();
  assert.match(a.html(), /<div id="signed"><div class="row"><span>Game id<\/span><b>1212121212121212…<\/b><\/div><label>The signed manifest \(hex\)<\/label><textarea id="mhex" rows="5" readOnly="">beef<\/textarea>/);
  const bad = area({ signManifest: () => { throw new Error('the manifest is not JSON'); } });
  bad.m.sign();
  assert.deepEqual([bad.m.state.signErr, bad.m.state.signed], ['the manifest is not JSON', null]);
  assert.match(area({ devKey: null, how: 'extension' }).html(), /none with a Nostr signer - sign games with your 24 words or your nsec<\/b>.*<button type="button" class="primary" id="sign" disabled="">Sign<\/button>/);
});

test('the login: the words shown on a press and forgotten; a Nostr login signs out', () => {
  let forgot = 0;
  const a = area({ onForget: () => forgot++ });
  a.m.setState({ words: a.m.props.onShowWords() });
  assert.match(a.html(), /<div id="shown"><div class="words"><span>w1<\/span><span>w2<\/span><\/div><\/div>/);
  const n = area({ how: 'nsec', onForget: () => forgot++ });
  assert.match(n.html(), /<p>This browser keeps your login and your nsec\. Your key stays with your nsec - keep it written down\.<\/p><button type="button" id="forget">Sign out on this browser<\/button>/);
});

test('Donations only with a developer on this node - a dev client or a game developer\'s key; installing one is in Developer (2026-10-22)', () => {
  const without = area({ hasDevs: false }).html();
  assert.doesNotMatch(without, /href="#money"/, 'no Donations in the menu');
  assert.match(without, /<section id="s-money" hidden="">/, 'its section kept (the panels draw into it), hidden');
  assert.match(without, /<section id="s-developer"[^>]*><h2>Developer<\/h2><div id="dev-add"><\/div><div id="gamedev-add"><\/div>/, 'where a dev client or a key is added');
  assert.match(area({ hasDevs: true }).html(), /href="#money"[^>]*>Donations/);
});

// THE PUBLIC DASHBOARD IN THE MENU (kanban #733, the owner: "make the link to the public dashboard a regular button in the navigation, would
// look nicer and not jump around"): the menu's last entry, after the sections, to the node's own dashboard
test('the public dashboard is the menu\'s last entry, not a link under the page', () => {
  const h = area({ needs: [], publicLink: 'http://127.0.0.1:8770/Dashboard' }).html();
  assert.match(h, /data-s="login">Your login<span class="dot" id="dot-login"><\/span><\/a><a href="http:\/\/127\.0\.0\.1:8770\/Dashboard" class="out" id="side-public" target="_blank" rel="noopener noreferrer">Public dashboard <span aria-hidden="true">↗<\/span><\/a><\/nav>/);
  assert.doesNotMatch(area({ needs: [] }).html(), /side-public/, 'none without an address');
});
