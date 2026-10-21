// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S ROLES AS TILES (kanban #563, the owner 2026-10-21: "The roles screen looking very not intuitive, you must vamp it up so
// it looks modern"): one tile per role with what it earns, a switch where it can be changed, the save bar only once something changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('async function rolesPanel() {');
const code = HTML.slice(a, HTML.indexOf('// CUSTODY, ADDED LATER', a));
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Just enough of a page for the panel: elements by id, a switch's checked state read from the markup, a tile's classes. */
function page() {
  const els = {};
  const tiles = {};
  const tileOf = (k) => (tiles[k] = tiles[k] || { cls: new Set(), pill: { className: '', textContent: '' }, foot: { textContent: '' },
    classList: { toggle(c, on) { on ? this.owner.cls.add(c) : this.owner.cls.delete(c); } }, querySelector(q) { return q === '.pill' ? this.pill : this.foot; } });
  const $ = (id) => {
    if (els[id]) return els[id];
    const m = /^rl-(play|settlement|relay|custody)$/.exec(id);
    if (m) {
      const html = els.roles ? els.roles.innerHTML : '';
      const tag = (new RegExp(`<input type="checkbox" id="${id}"[^>]*>`).exec(html) || [''])[0];
      if (!tag) return null;
      const t = tileOf(m[1]); t.classList.owner = t;
      els[id] = { checked: / checked/.test(tag), dataset: { was: (/data-was="(\d)"/.exec(tag) || [0, '0'])[1] }, closest: () => t };
      return els[id];
    }
    return (els[id] = { innerHTML: '', hidden: true, textContent: '', disabled: false, onclick: null });
  };
  return { $, els, tiles };
}
async function render({ roles = ['game', 'verify', 'settlement'], guardianCapable = false, guardian = null, gateway = null, liquidity = null, inCensus = true } = {}) {
  const p = page();
  const answers = { '/roles': { nodes: inCensus ? [{ node: 'me', roles, guardianCapable }] : [] }, '/guardian': guardian, '/gateway-claim': gateway, '/liquidity-claim': liquidity };
  const fetch = async (u) => ({ ok: answers[u] !== null, json: async () => answers[u] });
  const document = { querySelectorAll: () => [] };
  const fn = new Function('$', 'at', 'fetch', 'post', 'signed', 'esc', 'state', 'document', `${code}; return rolesPanel;`)(p.$, (x) => x, fetch, async () => ({ ok: true }), async () => ({}), esc, { node: 'me' }, document);
  await fn();
  return p;
}

test('six tiles: what each earns, on or off, a switch for the advertised roles and custody, a link for the gateway and liquidity', async () => {
  const { els } = await render({ gateway: { gatewayUrl: 'https://x/gateway/' } });
  const html = els.roles.innerHTML;
  assert.equal((html.match(/class="tile[ "]/g) || []).length, 6);
  for (const k of ['play', 'settlement', 'relay', 'custody']) assert.match(html, new RegExp(`id="rl-${k}"`), `${k} has a switch`);
  assert.match(html, /id="tile-play"[^>]*>|class="tile on" id="tile-play"/);
  assert.match(html, /class="tile on" id="tile-settlement"/);
  assert.match(html, /class="tile" id="tile-relay"/);
  assert.match(html, /A share of every round&#39;s node fee|A share of every round's node fee/);
  assert.match(html, /data-open="custody">Manage →/, 'the gateway is on: Manage');
  assert.match(html, /data-open="liquidity">Set up →/);
});

test('the save bar appears only when a switch changed, counts the changes, and Undo puts them back', async () => {
  const p = await render();
  assert.match(p.els.roles.innerHTML, /id="rl-bar" hidden/, 'hidden until something changes');
  const relay = p.$('rl-relay');
  relay.checked = true; relay.onchange();
  assert.equal(p.els['rl-bar'].hidden, false);
  assert.equal(p.els['rl-count'].textContent, '1 change not saved');
  assert.ok(p.tiles.relay.cls.has('changed'));
  p.els['rl-cancel'].onclick();
  assert.equal(relay.checked, false);
  assert.equal(p.els['rl-bar'].hidden, true);
});

test('a node not in the census yet: no switches, the reason said', async () => {
  const { els } = await render({ inCensus: false });
  assert.doesNotMatch(els.roles.innerHTML, /id="rl-(play|settlement|relay|custody)"/);
  assert.match(els.roles.innerHTML, /not in the census yet/);
});
