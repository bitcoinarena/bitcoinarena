// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OTHER WALLETS IN THIS BROWSER IN REACT (kanban #564, the Wallet's Federations tab since #631): the other phrases kept here, how
// each federation's merge into this wallet stands, the sats on their way, and "Merge now" - which opens no wallet, it merges. Nothing
// at all when there is no other wallet and nothing on its way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OtherWallets } from '../dist/test/others.mjs';

const html = (props) => renderToStaticMarkup(React.createElement(OtherWallets, { onMerge() {}, ...props }));

test('the other wallets, each federation\'s merge, the sats on their way; nothing when there is nothing', () => {
  assert.equal(html({}), '');
  assert.equal(html({ wallets: [], feds: [{ federation: 'ab'.repeat(32), onWaySats: 0, merge: null }] }), '', 'no wallet and nothing on its way');
  const h = html({ wallets: [{ hex: 'aa'.repeat(32), busy: false }, { hex: 'cc'.repeat(32), busy: true }],
    feds: [{ federation: '337ae01a'.repeat(8), onWaySats: 1500, merge: { state: 'merging' } }, { federation: '4dc88be7'.repeat(8), onWaySats: 0, merge: { state: 'stuck', why: 'its guardians do not answer' } }],
    mergingSats: 1500 });
  assert.match(h, /<div class="ow-head">Other wallets in this browser<\/div>/);
  assert.match(h, /Wallet aaaaaaaa…<\/div>/);
  assert.match(h, /Wallet cccccccc…<span class="muted"> · open in another tab - close it to merge<\/span>/);
  assert.match(h, /337ae01a…<\/span><span>1,500 sat on its way<\/span><span class="muted">merging …<\/span>/);
  assert.match(h, /4dc88be7…<\/span><span><\/span><span class="muted">waiting<\/span>/);
  assert.match(h, /1,500 sat merging into this wallet now\./);
  assert.match(h, /its guardians do not answer/);
  assert.match(h, /<button type="button" class="ow-merge">Merge now into this wallet<\/button>/);
  assert.match(html({ wallets: [{ hex: 'aa'.repeat(32) }], feds: [{ federation: 'ef'.repeat(32) }], merging: true }), /disabled="">Merging …<\/button>/);
});

test('"Merge now" merges in every federation listed', () => {
  const merged = [];
  const feds = [{ federation: '337ae01a'.repeat(8) }, { federation: '4dc88be7'.repeat(8) }];
  const out = new OtherWallets({ wallets: [{ hex: 'aa'.repeat(32) }], feds, onMerge: (f) => merged.push(f) }).render();
  const find = (el) => (!el || typeof el !== 'object' ? null : el.props && el.props.className === 'ow-merge' ? el
    : [].concat(el.props ? el.props.children : []).flat(Infinity).map(find).find(Boolean) || null);
  find(out).props.onClick();
  assert.deepEqual(merged, [[feds[0].federation, feds[1].federation]]);
});
