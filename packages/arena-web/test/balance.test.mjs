// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "YOUR BALANCE" BY FEDERATION IN REACT (kanban #564): the rows the page's paintSplit builds - each federation with its sats, health dot
// and word with its load, the note (a full one's warning in its tone) - the words when none holds funds, the total with arriving and
// pending, the head's close hidden inside the Wallet and handed back when pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BalanceSplit } from '../dist/test/balance.mjs';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const ROWS = [{ federation: A, level: 'bad', label: 'Full · load 433 %', note: 'It holds more than its guardians’ bonds cover.', value: '2,500 sat' },
  { federation: B, level: 'ok', label: 'Healthy · load 67 %', note: '', value: '53 sat' }];

test('each federation, its health and note, the total; the close shown in the popup', () => {
  const h = renderToStaticMarkup(React.createElement(BalanceSplit, { title: 'Your balance', closable: true, rows: ROWS, total: { label: 'Total (2 federations)', value: '2,553 sat + 100 sat arriving' } }));
  assert.match(h, /^<div class="ov-head"><h4>Your balance<\/h4><button type="button" class="ov-close" title="Close">×<\/button><\/div>/);
  assert.match(h, /<div class="fed">Federation aaaaaaaa…<\/div><div class="st"><span class="hl bad"><\/span>Full · load 433 %<\/div><div class="note bad">It holds more/);
  assert.match(h, /<div class="st"><span class="hl ok"><\/span>Healthy · load 67 %<\/div><\/div><b>53 sat<\/b>/);
  assert.match(h, /<div class="row total"><div>Total \(2 federations\)<\/div><b>2,553 sat \+ 100 sat arriving<\/b><\/div>$/);
});

test('inside the Wallet: its own head, no close; none held; the close handed back', () => {
  const w = renderToStaticMarkup(React.createElement(BalanceSplit, { title: 'By federation', closable: false, rows: [], empty: 'No federation holds funds of this wallet yet', total: null }));
  assert.match(w, /<h4>By federation<\/h4><button type="button" class="ov-close" title="Close" hidden="">/);
  assert.match(w, /<div class="row">No federation holds funds of this wallet yet<\/div>$/);
  let closed = 0;
  const c = new BalanceSplit({ title: 'Your balance', closable: true, rows: [], onClose: () => closed++ });
  const head = c.render().props.children[0];
  head.props.children[1].props.onClick({ stopPropagation() {} });
  assert.equal(closed, 1);
});

test('debug: every federation read, its status and load, reserve against cap, a HALTED one’s payback, "Deposit here" into that one', () => {
  const deposited = [];
  const debug = { rows: [
    { federation: A, level: 'ok', state: 'OPEN · load 12 %', cap: 'reserve 1,200 / cap 10,000 sat · room 8,800 sat · 7 signers', note: '', canDeposit: true, onDeposit: () => deposited.push(A) },
    { federation: B, level: 'bad', state: 'HALTED', cap: 'reserve 0 / cap 0 sat · room 0 sat', note: 'Paid back in about 12 blocks (2 h)', canDeposit: false, onDeposit() {} }] };
  const h = renderToStaticMarkup(React.createElement(BalanceSplit, { title: 'Your balance', closable: true, rows: [], total: null, debug }));
  assert.match(h, /<div class="dbg-h">All federations \(debug\) · 2<\/div><div class="row"><div><div class="fed">Federation aaaaaaaa…<\/div><div class="st"><span class="hl ok"><\/span>OPEN · load 12 %<\/div><div class="dbg-cap">reserve 1,200 \/ cap 10,000 sat · room 8,800 sat · 7 signers<\/div><\/div><button type="button" class="dep-here">Deposit here<\/button><\/div>/);
  assert.match(h, /<div class="note bad">Paid back in about 12 blocks \(2 h\)<\/div><\/div><button type="button" class="dep-here" disabled="" title="its record names no invite">Deposit here<\/button>/);
  assert.match(renderToStaticMarkup(React.createElement(BalanceSplit, { title: 'x', rows: [], debug: { rows: [] } })), /All federations \(debug\) · 0<\/div><div class="row">No federation record read yet<\/div>$/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(BalanceSplit, { title: 'x', rows: [] })), /dbg-h/);
  const parts = new BalanceSplit({ title: 'x', rows: [], debug }).render().props.children;
  const button = parts[4].props.children[2][0].props.children[1];
  let stopped = 0; button.props.onClick({ stopPropagation: () => stopped++ });
  assert.deepEqual([deposited, stopped], [[A], 1]);
});
