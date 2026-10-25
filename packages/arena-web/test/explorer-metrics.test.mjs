// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXPLORER'S METRICS PAGE (kanban #676, 2026-10-25: "Explorer also shows volume in Sats / btc per day, current protocol reserve in sats /
// btc, and total referrer fees accumulated in sats / btc. Moves to btc when it's over 1 million Satoshi", "This is On a metrics page").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { amount, Metrics } from '../dist/test/explorer.mjs';

test('amounts in sats below 1,000,000 sat, in BTC from there on', () => {
  assert.deepEqual([amount('0'), amount('889830'), amount('999999999'), amount('1000000000'), amount('12345678000'), amount(null)],
    ['0 sat', '889 sat', '999,999 sat', '0.01 BTC', '0.12345678 BTC', '–']);
});

test('the page: today\'s volume, the reserve, the referral fees; a bar per day; the websites', () => {
  const today = new Date().toISOString().slice(0, 10);
  const data = { volume: [{ day: today, txs: 812, msat: '2500000000' }, { day: '2026-10-24', txs: 40, msat: '400000000' }],
    reserve: { msat: '889830', federations: [{ federation: 'aa', msat: '889830' }] }, referral: { msat: '0', sites: [] }, readAt: new Date().toISOString(), seats: { reserves: 13, referral: 13, of: 14 } };
  const h = renderToStaticMarkup(React.createElement(Metrics, { data }));
  assert.match(h, /<span>Volume today<\/span><b>0\.025 BTC<\/b>/);
  assert.match(h, /<span>Protocol reserve<\/span><b>889 sat<\/b><small>1 federation<\/small>/);
  assert.match(h, /<span>Referral fees paid<\/span><b>0 sat<\/b><small>0 websites<\/small>/);
  assert.match(h, new RegExp(`<td class="nw">${today}</td><td>812</td><td class="nw"><b>0.025 BTC</b></td><td class="barcell"><i class="vbar" style="width:100%"></i>`));
  assert.match(h, /<td class="nw">2026-10-24<\/td><td>40<\/td><td class="nw"><b>400,000 sat<\/b><\/td><td class="barcell"><i class="vbar" style="width:16%"><\/i>/);
  assert.match(h, /read from 13 of 14 nodes/);
  const withSite = renderToStaticMarkup(React.createElement(Metrics, { data: { ...data, referral: { msat: '1500000', sites: [{ site: '03' + 'ab'.repeat(32), msat: '1500000', payouts: 2 }] } } }));
  assert.match(withSite, /<h2>Referral fees by website<\/h2>.*<td class="mono">03ababababababab…<\/td><td>2<\/td><td class="nw"><b>1,500 sat<\/b>/);
});
