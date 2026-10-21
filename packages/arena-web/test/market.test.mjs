// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PREDICTION MARKET'S VIEWS IN REACT (kanban #564): drawn from btc-updown market.js's own pickSheet() and marketLines() - the sheet's
// outcomes, fees and confirmation; the orders' states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PickSheet, MarketLines, STATE_LABEL } from '../dist/test/market.mjs';
import { pickSheet, marketLines } from '../../btc-updown/page/market.js';

const market = { name: 'BTC Up/Down 15m', outcomes: ['Up', 'Down'], fee: { nodeBps: 50, donationBps: 50 }, threshold: 3, attestors: ['a', 'b', 'c', 'd'], devKey: 'ab'.repeat(32), gameId: 'cd'.repeat(32), needsConfirm: false };

test('the pick sheet from market.js: both outcomes, the stake and fees, what is at risk, who decides; an unlisted market waits for a confirmation', () => {
  const sheet = pickSheet({ market, stakeMsat: 100000000n });
  const html = renderToStaticMarkup(React.createElement(PickSheet, { sheet }));
  assert.match(html, />Up<\/button>/); assert.match(html, />Down<\/button>/);
  assert.match(html, /stake 100,000 sats/); assert.match(html, /at risk on your pick/); assert.match(html, /outcome by 3 of 4 attestors/);
  assert.doesNotMatch(html, /disabled/);
  const unlisted = renderToStaticMarkup(React.createElement(PickSheet, { sheet: pickSheet({ market: { ...market, needsConfirm: true }, stakeMsat: 100000000n }) }));
  assert.match(unlisted, /not on this page&#x27;s list of known markets|not on this page's list of known markets/);
  assert.match(unlisted, /<button type="button" class="primary" disabled="">Up<\/button>/, 'no pick before the confirmation');
});

test('the orders from market.js: an open one with its state, one waiting for its attestors; every state market.js names has a label', () => {
  const now = Date.UTC(2026, 9, 21, 9, 0);
  const picks = [{ market, pick: 0, roundIdHex: '11'.repeat(32), entryIdHex: '22'.repeat(32), stakeMsat: 100000000n, entryCloseMs: now + 600000 },
    { market, pick: 1, roundIdHex: '33'.repeat(32), entryIdHex: '44'.repeat(32), stakeMsat: 50000000n, entryCloseMs: now - 60000 }];
  const lines = marketLines({ picks, nowMs: now });
  assert.deepEqual(lines.map((l) => l.state), ['open', 'waiting']);
  const html = renderToStaticMarkup(React.createElement(MarketLines, { lines, nowMs: now }));
  assert.match(html, /<span class="pill wait">Open<\/span>/); assert.match(html, /Waiting for the result/);
  for (const st of ['open', 'waiting', 'void', 'disputed', 'unverified', 'won', 'lost', 'refunded', 'settled', 'unknown']) assert.ok(STATE_LABEL[st], st);
  assert.match(renderToStaticMarkup(React.createElement(MarketLines, { lines: [] })), /No orders yet/);
});
