// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEPOSIT WINDOW IN REACT (kanban #564): the offer's tabs with the first one chosen and its invoice made (QR, Copy, the gateway named
// under it), Custom typed into an invoice after the last key, the payment's end said by the watcher, a paid deposit that falls short asking
// the rest of the fees in the same window, and the connected wallet's balance against the invoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DepositModal, satNum, restWords } from '../dist/test/deposit.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function offerOf(over = {}) {
  const asked = [], watchers = [];
  let paid; const claimed = new Promise((r) => { paid = r; });
  const o = { choices: [{ key: 'r1', label: '1 round', rounds: 1, msat: 101000n }, { key: 'r5', label: '5 rounds', rounds: 5, msat: 505000n }, { key: 'custom', label: 'Custom' }],
    perRoundStake: 100000n, restMsat: null, claimed, closed: 0,
    invoice: async (msat) => { asked.push(msat); return { invoice: `lntbs${msat}n1x`, amountMsat: String(msat), gateway: 'https://gw-a.example:8443/v1' }; },
    watch: (w) => watchers.push(w), close() { o.closed++; }, ...over };
  return { o, asked, watchers, paid: () => paid() };
}
function mount(props) {
  const m = new DepositModal({ qrSvg: (i) => `<svg data-i="${i}"></svg>`, whyLine: () => 'why one round', onDone() { m.doneCalls = (m.doneCalls || 0) + 1; }, ...props });
  m.setState = (u, cb) => { Object.assign(m.state, typeof u === 'function' ? u(m.state) : u); if (cb) cb(); };
  m.componentDidMount();
  return m;
}
const html = (m) => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render()));

test('the tabs, the first chosen: its invoice, the QR, Copy, the gateway named; Close closes the offer', async () => {
  const { o, asked } = offerOf();
  const m = mount({ offer: o, title: 'Deposit into your player wallet' });
  await wait(0);
  assert.deepEqual(asked, [101000n]);
  const h = html(m);
  assert.match(h, /^<button type="button" class="dep-close" title="Close">×<\/button><div class="dep-title">Deposit into your player wallet<\/div><div class="dep-backup-host" style="display:contents"><\/div>/);
  assert.match(h, /<button type="button" data-key="r1" class="on">1 round<\/button><button type="button" data-key="r5">5 rounds<\/button><button type="button" data-key="custom">Custom<\/button>/);
  assert.match(h, /<div class="dep-custom" style="visibility:hidden">/);
  assert.match(h, /<div class="dep-amount">Pay 101 sat from any Lightning wallet to top up your player wallet\.<\/div><div class="dep-why">why one round<\/div>/);
  assert.match(h, /<svg data-i="lntbs101000n1x"><\/svg>/);
  assert.match(h, /<code class="dep-invoice">lntbs101000n1x<\/code><button type="button" class="dep-copy">Copy invoice<\/button>/);
  assert.match(h, /<div class="pay-status busy"><div class="pay-status-text">Waiting for your Lightning payment of 101 sat via gw-a\.example:8443 …<\/div><div class="pay-bar"><div class="pay-bar-fill" style="width:66\.66666666666666%"><\/div>/);
  m.close();
  assert.deepEqual([o.closed, m.doneCalls], [1, 1]);
});

test('Custom: nothing typed says so, a typed amount is made 450 ms after the last key; an older invoice never shows over it', async () => {
  const { o, asked } = offerOf();
  const m = mount({ offer: o });
  m.choose(o.choices[2]);
  assert.equal(m.state.tab, 'custom'); assert.equal(m.state.why, '');
  assert.deepEqual([m.state.amount, m.state.status.words, m.state.invoice], ['Enter an amount in sat.', 'Enter an amount in sat.', null]);
  assert.match(html(m), /<div class="dep-custom" style="visibility:visible">.*<div class="qr-hold">The QR code appears as soon as you enter an amount<\/div>/);
  m.typed('2'); m.typed('25');
  assert.equal(m.state.amount, 'Pay 25 sat from any Lightning wallet to top up your player wallet.');
  await wait(600);
  assert.deepEqual(asked, [101000n, 25000n]);
  assert.equal(m.state.invoice, 'lntbs25000n1x');
  m.componentWillUnmount();
});

test('the watcher says the payment\'s end; a paid deposit that falls short asks the rest in the same window, the tabs unseen', async () => {
  const rest = offerOf({ restMsat: 3000n, restPayMsat: 5000n, choices: [] });
  const { o, watchers, paid } = offerOf({ outcome: Promise.resolve({ funded: false, rest: rest.o }) });
  const m = mount({ offer: o });
  await wait(0);
  watchers[0]({ invoice: 'lntbs101000n1x', amountMsat: '101000' }, 'Claimed');
  assert.deepEqual([m.state.status.step, m.state.status.words, m.state.status.kind], [3, 'Payment received! 101 sat are now in your wallet.', 'ok']);
  paid();
  await wait(2200);
  assert.deepEqual(rest.asked, [5000n]);
  assert.equal(restWords(rest.o), 'This round needs 3 more sat for fees. The smallest Lightning deposit is 5 sat. Pay 5 sat to join.');
  const h = html(m);
  assert.match(h, /<div class="dep-title">This round needs 3 more sat for fees\. The smallest Lightning deposit is 5 sat\. Pay 5 sat to join\.<\/div>/);
  assert.match(h, /<div class="dep-tabs" style="visibility:hidden">/);
  watchers[0]({ invoice: 'lntbs5000n1x', amountMsat: '5000' }, 'Expired');   // the first offer's watcher no longer speaks
  assert.equal(m.state.status.step, 2);
  rest.watchers[0]({ invoice: 'lntbs5000n1x', amountMsat: '5000' }, 'Expired');
  assert.equal(m.state.status.words, 'This invoice has expired and nothing was charged.');
  m.componentWillUnmount();
});

test('a connected wallet: its balance against the invoice, the button off when short; exact msat amounts', async () => {
  const N = { nwcBalance: async () => 50000n };
  const seen = [];
  const { o } = offerOf();
  const m = mount({ offer: o, nwc: { uri: () => 'nostr+walletconnect://x', load: async () => N, keep() {}, forget() {} }, onNwc: (x) => seen.push(x) });
  await wait(0); await wait(0);
  assert.deepEqual(seen, [{ balanceMsat: '50000' }]);
  assert.match(html(m), /<button type="button" class="dep-nwc-pay" disabled="".*>My wallet has 50 sat - not enough for this<\/button>/);
  assert.match(html(m), /Wallet connected in this browser · <a href="#"/);
  assert.equal(satNum(1234567n), '1,234.567'); assert.equal(satNum(5000n), '5');
  const none = mount({ offer: offerOf().o });
  assert.match(html(none), />Connect my wallet to pay in one tap \(Nostr Wallet Connect\)<\/button>/);
  assert.doesNotMatch(html(none), /dep-webln-pay/);
});
