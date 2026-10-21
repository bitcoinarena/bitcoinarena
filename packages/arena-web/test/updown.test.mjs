// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN UP OR DOWN VERSION 16 IN REACT (kanban #564): an order's card with its cancel (held while it is asked), a past order's card and
// table row, the totals in full and short, the sheet in Market and Limit with Buy's progress, and the line outside the Arena page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrderCard, PastCard, PastTable, TotalsLong, TotalsShort, Sheet, UpDownView, KindChip } from '../dist/test/updown.mjs';

const r = (c, p) => renderToStaticMarkup(React.createElement(c, p));
const O = ['Up', 'Down'];

test('an order\'s card: side, amount, limit, window, its chip; cancel only when it can be, held while asked', () => {
  const c = { side: 0, amount: '500 sats', limit: 60, window: '21 Oct · 23:30–23:45 UTC', chip: ['open', 'closes in 26:14'], cancel: { entry: 'e1', busy: false } };
  assert.equal(r(OrderCard, { c, outcomes: O, onCancel: () => {} }), '<div class="ord"><span class="sd up">▲ Up</span><div class="what"><b>500 sats</b> <span class="lim">≤ 60¢</span><div class="win">21 Oct · 23:30–23:45 UTC</div></div><div class="st"><span class="chip2 open">closes in 26:14</span><button type="button" data-cancel="e1">cancel</button></div></div>');
  assert.match(r(OrderCard, { c: { ...c, cancel: { entry: 'e1', busy: true } }, outcomes: O }), /<button type="button" data-cancel="e1" disabled="">cancel<\/button>/);
  assert.match(r(OrderCard, { c: { ...c, side: 1, cancel: null, cls: ' flight', chip: ['wait', 'placing…'] }, outcomes: O }), /^<div class="ord flight"><span class="sd down">▼ Down<\/span>.*<span class="chip2 wait">placing…<\/span><\/div><\/div>$/);
});

test('past orders: a card, a table row, nothing yet; the totals in full and short', () => {
  const p = { entry: 'e2', side: 1, window: '21 Oct · 23:00–23:15 UTC', final: false, status: 'pending · final in 4:57', stake: '1,000 sats', limit: 45, result: 'Down won', pl: '+1,100 sats', plCls: 'won' };
  assert.match(r(PastCard, { p, outcomes: O }), /<span class="fin pend">pending · final in 4:57<\/span>.*<b class="won">\+1,100 sats<\/b>/);
  assert.match(r(PastTable, { past: [p], outcomes: O }), /<tr><td>21 Oct · 23:00–23:15 UTC<\/td><td class="down">▼ Down<\/td><td class="n">1,000 sats <span class="sub">≤ 45¢<\/span><\/td><td>Down won<\/td><td class="n won">\+1,100 sats<\/td><td class="pend">pending · final in 4:57<\/td><\/tr>/);
  assert.equal(r(PastTable, { past: [], outcomes: O }), '<div class="sub">No past orders yet: an order shows here once its round has a result.</div>');
  const t = { count: 2, won: '1,100 sats', lost: '200 sats', net: '900 sats', netMsat: 900000, wonNum: '1,100', lostNum: '200', netNum: '900', pend: 1 };
  assert.equal(r(TotalsLong, { t }), '2 closed · won <b class="won">+1,100 sats</b> · lost <b class="lost">−200 sats</b> · net <b class="won">+900 sats</b> · 1 pending');
  assert.equal(r(TotalsShort, { t: { ...t, pend: 0 } }), '2 closed · <b class="won">+1,100</b> · <b class="lost">−200</b> · net <b class="won">+900 sats</b>');
});

const V = { mode: 'market', modeLabel: 'Buy · Market', menuOpen: false, form: { amt: '100', lp: '50', sh: '100', exp: '0' }, sideName: 'Up', mwin: '170 sats', mprice: 'at 58¢',
  ltotal: '–', lwin: '–', err: '', go: { disabled: false, text: 'Buy Up' }, status: null, fee: 'Fee 1 %' };
test('the sheet: Market shown, Limit hidden; Limit the other way; Buy\'s progress', () => {
  const m = r(Sheet, { v: V, on: {} });
  assert.match(m, /<div id="market"><div class="amount">.*<input id="amt" inputMode="numeric" aria-label="amount in sats" value="100"\/>/);
  assert.match(m, /<div id="limit" hidden="">/);
  assert.match(m, /<div class="status" id="status" role="status" aria-live="polite"><span class="spin"><\/span><span id="statustxt"><\/span><\/div>/);
  const l = r(Sheet, { v: { ...V, mode: 'limit', modeLabel: 'Buy · Limit', menuOpen: true, status: { line: '✓ Order placed', cls: 'ok' }, go: { disabled: true, text: 'Buy Down' } }, on: {} });
  assert.match(l, /<div id="market" hidden="">/);
  assert.match(l, /<div class="menu open" id="menu"><button type="button" data-mode="market">Market<\/button><button type="button" data-mode="limit" class="on">Limit<\/button><\/div>/);
  assert.match(l, /<button type="button" class="go" id="go" disabled="">Buy Down<\/button><div class="status on ok" id="status"/);
});

test('outside the Arena page; the chip', () => {
  assert.equal(r(UpDownView, { vm: { outside: true }, on: {} }), '<div class="none">This market runs inside the Bitcoin Arena page, which hands it the market.</div>');
  assert.equal(r(KindChip, { text: 'PAID' }), '<span class="chip" id="kind">PAID</span>');
});
