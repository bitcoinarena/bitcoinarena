// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET'S HISTORY AND FEDERATIONS BOX IN REACT (kanban #564): the history's rows as the page builds them (when, what, amount in or
// out, a stake that opens its replay), the words when there are none; the federations box's lines in their colours and the health pill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalletHistory } from '../dist/test/wallet.mjs';
import { CustodyCard } from '../dist/test/custody-card.mjs';

test('the history: in and out, a stake that opens its replay, nothing yet', () => {
  let opened = 0;
  const rows = [{ key: 'a', plus: true, when: '2026-10-21 14:00 UTC', what: 'Deposit · 337ae01a', amt: '+1,000 sat', onOpen: null },
    { key: 'b', plus: false, when: '2026-10-21 14:05 UTC', what: 'Stake · round 4d2c7420', amt: '−100 sat', onOpen: () => opened++ }];
  const h = renderToStaticMarkup(React.createElement(WalletHistory, { rows, empty: 'No activity yet.' }));
  assert.match(h, /^<div class="hist-row plus"><span class="hist-when">2026-10-21 14:00 UTC<\/span><span class="hist-what" title="Deposit · 337ae01a">Deposit · 337ae01a<\/span><span class="hist-amt">\+1,000 sat<\/span><\/div>/);
  assert.match(h, /<div class="hist-row minus clickable" title="Open this round&#x27;s replay in a new window">/);
  const tree = new WalletHistory({ rows, empty: '' }).render();
  tree[1].props.onClick(); assert.equal(opened, 1);
  assert.equal(renderToStaticMarkup(React.createElement(WalletHistory, { rows: [], empty: 'No activity yet.' })), '<div class="empty">No activity yet.</div>');
});

test('the federations box: the head, each line in its colour with its tip, the health as a pill', () => {
  const h = renderToStaticMarkup(React.createElement(CustodyCard, { rows: [{ k: 'Nodes in the network', v: '31', tip: 'bonded nodes in the census at block 157194', color: '#58a6ff' },
    { k: 'Free before deposits stop', v: '0 sat', tip: '', color: '#f85149' }, { k: 'Health', v: '253 % · test network', tip: 'over capacity', color: '#0d1117', pill: '#f85149' }] }));
  assert.match(h, /^<div style="font-weight:700;font-size:14px;color:#f7931a;margin-bottom:4px">🏦 Federations<\/div>/);
  assert.match(h, /<div title="bonded nodes in the census at block 157194" style="[^"]*cursor:help"><span style="color:#a9b3c1">Nodes in the network<\/span><b style="font-weight:700;color:#58a6ff">31<\/b><\/div>/);
  assert.match(h, /<b title="over capacity" style="font-weight:700;color:#0d1117;background:#f85149;border-radius:999px;padding:1px 10px">253 % · test network<\/b>/);
});
