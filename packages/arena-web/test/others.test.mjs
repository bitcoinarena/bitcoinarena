// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OTHER WALLETS IN THIS BROWSER IN REACT (kanban #564): the page's line while reading or why not; the wallets with sats or unreadable,
// their total, "Use this wallet" only for one no other tab holds and that holds sats; a wallet with 0 sat never named, none at all = nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OtherWallets } from '../dist/test/others.mjs';

const html = (props) => renderToStaticMarkup(React.createElement(OtherWallets, { onUse() {}, ...props }));

test('a line, or the wallets with their total and "Use this wallet"; 0 sat never named', () => {
  assert.equal(html({ note: 'Reading the other wallets in this browser …' }), 'Reading the other wallets in this browser …');
  const h = html({ lines: [{ hex: 'aa'.repeat(32), sats: 1200, busy: false }, { hex: 'bb'.repeat(32), sats: 0, busy: false },
    { hex: 'cc'.repeat(32), sats: 300, busy: true }, { hex: 'dd'.repeat(32), sats: null, busy: false }] });
  assert.equal(h, '<div class="muted">Other wallets in this browser: 1500 sat</div>'
    + '<div class="muted">aaaaaaaa…  1200 sat  <button type="button">Use this wallet</button></div>'
    + '<div class="muted">cccccccc…  300 sat  (open in another tab)</div>'
    + '<div class="muted">dddddddd…  could not be read now  </div>');
  assert.equal(html({ lines: [{ hex: 'bb'.repeat(32), sats: 0, busy: false }] }), '');
  assert.equal(html({}), '');
});

test('"Use this wallet" hands its phrase to the page', () => {
  const used = [];
  const out = new OtherWallets({ lines: [{ hex: 'aa'.repeat(32), sats: 5, busy: false }], onUse: (hex) => used.push(hex) }).render();
  out.props.children[1][0].props.children[1].props.onClick();
  assert.deepEqual(used, ['aa'.repeat(32)]);
});
