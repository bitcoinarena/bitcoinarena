// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SHOP'S ITEMS IN REACT (kanban #564): a row per item with its picture, name, what it does and its price with the player's share; an
// owned item says so with its "Play with it" switch (on when no choice is kept, else as kept), any other its Buy button, off while its
// purchase runs and on again after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShopItems } from '../dist/test/shop.mjs';

const ITEMS = [{ id: 'hat', name: 'Hat', priceSat: 500n }, { id: 'cape', name: 'Cape', priceSat: 1000n }, { id: 'boots', name: 'Boots', priceSat: 200n }];
const base = { items: ITEMS, owned: [{ itemId: 'hat' }, { itemId: 'cape' }], picture: (id) => (id === 'hat' ? '<svg data-hat=""></svg>' : ''),
  what: (id) => (id === 'cape' ? 'flies' : ''), price: (p) => p + p / 10n, onUse() {}, onBuy: async () => {} };
const html = (props) => renderToStaticMarkup(React.createElement(ShopItems, { ...base, ...props }));

test('a row per item: picture, name, what it does, the price with the share; owned ones with their switch, the rest with Buy', () => {
  const h = html({ use: null });
  assert.match(h, /^<div class="item" data-item="hat"><div class="pic"><svg data-hat=""><\/svg><\/div><div><div class="name">Hat<\/div><div class="what">550 sat<\/div><\/div><div><div class="owned">Owned ✓<\/div><label class="use"><input type="checkbox" checked=""\/>Play with it<\/label><\/div><\/div>/);
  assert.match(h, /<div class="what">flies · 1100 sat<\/div>/);
  assert.match(h, /<div class="item" data-item="boots">.*<button type="button" class="buy">Buy · 220 sat<\/button><\/div><\/div>$/);
  // a kept choice: only the chosen owned items are switched on
  const kept = html({ use: ['cape'] });
  assert.match(kept, /data-item="hat">.*?<input type="checkbox"\/>Play with it/);
  assert.match(kept, /data-item="cape">.*?<input type="checkbox" checked=""\/>Play with it/);
  assert.equal(html({ items: [], use: null }), '');
});

test('Buy is off while its purchase runs, on again after; the switch hands its item and state to the page', async () => {
  let done; const bought = [];
  const m = new ShopItems({ ...base, use: null, onBuy: (it) => { bought.push(it.id); return new Promise((r) => { done = r; }); } });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  const p = m.buy(ITEMS[2]);
  assert.deepEqual([bought, m.state.buying], [['boots'], 'boots']);
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())), /<button type="button" class="buy" disabled="">Buy · 220 sat<\/button>/);
  done(); await p;
  assert.equal(m.state.buying, null);
  const used = [];
  const row = new ShopItems({ ...base, use: null, onUse: (id, on) => used.push([id, on]) }).render()[0];
  const label = row.props.children[2].props.children.props.children[1];
  label.props.children[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(used, [['hat', false]]);
});
