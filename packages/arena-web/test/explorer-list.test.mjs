// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXPLORER'S LIST, A PAGE AT A TIME, WITH EVERY KIND (kanban #683, 2026-10-26: "I don't see item purchases in the explorer and I don't see
// other apps in the explorer. Add paging to the explorer to display more than a 1000"; #682: a gift "doesn't show in the explorer").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { List, Payment, pageOf, rowApp } from '../dist/test/explorer.mjs';

const hex = (n) => n.toString(16).padStart(64, '0');
const FED = 'fe'.repeat(32);

test('the list: every app and kind of the store in the filters with its count, each row\'s kind, and Older / Newer from the page\'s cursors', () => {
  const data = { txs: [
    { id: hex(1), kind: 'item', app: 'nextblock', federation: FED, storedMs: Date.now() - 5000, stakeMsat: '500000', item: 'nextblock · large-truck', result: null },
    { id: hex(2), kind: 'zap', app: null, federation: FED, storedMs: Date.now() - 6000, stakeMsat: '21000', item: 'zap', result: null },
    { id: hex(3), kind: 'donation', app: null, federation: FED, storedMs: Date.now() - 7000, stakeMsat: '1000000', item: 'donation · protocol · from site', result: null },
    { id: hex(4), kind: 'order', app: 'rock-paper-scissors', round: 'ab'.repeat(32), federation: FED, storedMs: Date.now() - 8000, stakeMsat: '100000', result: { state: 'won', netMsat: '95000', payoutMsat: '195000' } }],
  older: `1800000000000_${hex(4)}`, newer: null, total: 1404,
  facets: { apps: [{ app: 'btc-updown-15m', n: 1200 }, { app: 'nextblock', n: 151 }, { app: 'rock-paper-scissors', n: 51 }, { app: '-', n: 2 }],
    kinds: [{ kind: 'order', n: 1401 }, { kind: 'item', n: 1 }, { kind: 'donation', n: 1 }, { kind: 'zap', n: 1 }], feds: [{ federation: FED, n: 1404 }] } };
  const h = renderToStaticMarkup(React.createElement(List, { data }));
  assert.match(h, /<option value="btc-updown-15m">Bitcoin Up or Down \(1,200\)<\/option><option value="nextblock">Tick Tock, Next Block \(151\)<\/option><option value="rock-paper-scissors">Rock Paper Scissors \(51\)<\/option><option value="-">No app \(2\)<\/option>/);
  assert.match(h, /<option value="item">Item bought \(1\)<\/option><option value="donation">Donation \(1\)<\/option><option value="zap">Zap \(1\)<\/option>/);
  assert.match(h, /4 of 1,404/);
  assert.match(h, /<td>Tick Tock, Next Block<\/td><td class="nw">Item bought<span class="dim"> · large-truck<\/span><\/td><td class="n nw">500 sat<\/td><td class="nw dim">Paid<\/td>/);
  assert.match(h, /<td>–<\/td><td class="nw">Zap<\/td><td class="n nw">21 sat<\/td>/);
  assert.match(h, /<td>Protocol<\/td><td class="nw">Donation<\/td><td class="n nw">1,000 sat<\/td>/);
  assert.match(h, /<td>Rock Paper Scissors<\/td><td class="nw">Order<\/td><td class="n nw">100 sat<\/td><td class="nw ok">\+95 sat<\/td>/);
  // the newest page: Newer and Newest off, Older on
  assert.match(h, /<div class="pager"><button type="button" disabled="">Newest<\/button><button type="button" disabled="">Newer<\/button><button type="button">Older<\/button><\/div>/);
  // the last page of all: no pager drawn when there is neither
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(List, { data: { ...data, older: null } })), /class="pager"/);
  // the Worker before pages built in an array: still drawn, its apps from its rows
  assert.deepEqual(pageOf([{ id: hex(9) }]), { txs: [{ id: hex(9) }], older: null, newer: null, total: 1, facets: null });
  assert.deepEqual([rowApp({ app: 'btc-updown-15m' }), rowApp({ kind: 'donation' }), rowApp({ kind: 'zap' }), rowApp({})], ['Bitcoin Up or Down', 'Protocol', '–', 'unknown']);
});

test('a gift, a zap and an item bought: to whom, from whom, its federation transaction and each output, and the nodes that keep it', () => {
  const seats = [{ seat: 'guardian-1', known: true, status: 200, storedAt: '2026-10-26T08:00:01.000Z' }, { seat: 'guardian-7', known: false, status: 404, storedAt: null }];
  const gift = { id: hex(0xa1), kind: 'donation', amountMsat: '1000000', entry: { app: 'rock-paper-scissors' }, storedFirst: '2026-10-26T08:00:01.000Z', seats,
    payment: { target: 3, gameName: 'rock-paper-scissors', origin: 'app:rock-paper-scissors', donor: 'd0'.repeat(32), federation: FED, txid: 'aa'.repeat(32), atMs: 1792915200000,
      outputs: [{ outIdx: 0, pk: '02' + '11'.repeat(32), msat: '500000' }, { outIdx: 1, pk: '02' + '12'.repeat(32), msat: '500000' }] } };
  const h = renderToStaticMarkup(React.createElement(Payment, { tx: gift }));
  assert.match(h, /<h1>Donation<\/h1>/);
  assert.match(h, /<dt>To<\/dt><dd>protocol and Rock Paper Scissors developers, half each<\/dd><dt>Given on<\/dt><dd>Rock Paper Scissors<\/dd><dt>Amount<\/dt><dd>1,000 sat<\/dd>/);
  assert.match(h, new RegExp(`<dt>Federation transaction</dt><dd class="mono">${'aa'.repeat(32)}</dd>`));
  assert.match(h, /<td>1<\/td><td class="mono">02(12){32}<\/td><td class="n nw">500 sat<\/td>/);
  assert.match(h, /<b>Nodes<\/b> <span class="dim">1 of 2<\/span>/);
  const item = { ...gift, id: hex(0xb1), kind: 'item', amountMsat: '500000', entry: { app: 'nextblock' },
    payment: { itemId: 'large-truck', priceSat: '500', gameName: 'nextblock', player: 'c0'.repeat(32), federation: FED, txid: 'bb'.repeat(32), atMs: 1792915200000,
      outputs: [{ outIdx: 0, pk: '02' + '14'.repeat(32), msat: '100000', reserve: true }] } };
  const hi = renderToStaticMarkup(React.createElement(Payment, { tx: item }));
  assert.match(hi, /<h1>Item bought<\/h1>.*<dt>App<\/dt><dd>Tick Tock, Next Block<\/dd><dt>Item<\/dt><dd>large-truck <span class="dim">· price 500 sat<\/span><\/dd>/);
  assert.match(hi, new RegExp(`<dt>Buyer</dt><dd class="mono">${'c0'.repeat(32)}</dd>`));
  assert.match(hi, /<span class="dim"> · protocol reserve<\/span>/);
  const zap = { ...gift, kind: 'zap', entry: { app: null }, payment: { ...gift.payment, target: 2, gameName: null, origin: null, gameDev: '42'.repeat(32) } };
  assert.match(renderToStaticMarkup(React.createElement(Payment, { tx: zap })), new RegExp(`<h1>Zap</h1>.*<dt>To</dt><dd>the player<span class="mono dim"> · ${'42'.repeat(32)}</span>`));
});
