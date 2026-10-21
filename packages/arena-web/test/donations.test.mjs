// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S DONATIONS IN REACT (kanban #564): what is waiting at this seat per set, recipient (a key, or its Lightning address when
// it has none), day and round; the dev clients - earnings by period, holdings, withdraw (an invoice, or an address with an amount), remove,
// and setting one up - each handing its signed request to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingDonations, DevClients, sat } from '../dist/test/donations.mjs';

test('waiting at this seat: the total, each set, each recipient by key or Lightning address, by day and by round', () => {
  const r = { totalMsat: '1500500', sets: [{ setId: 'ab'.repeat(32), title: 'Protocol developers', kind: 'protocol', serial: 3, recipients: [
    { label: 'dev a', key: '02' + 'cd'.repeat(32), totalMsat: '1000000', donations: 2, byDay: [{ day: '2026-10-21', msat: '1000000' }], byRound: [{ roundId: 'ef'.repeat(32), msat: '500000' }] },
    { label: 'dev b', key: null, lnurl: 'devb@getalby.com', totalMsat: '500500', donations: 1, byDay: [], byRound: [] }] }] };
  const h = renderToStaticMarkup(React.createElement(WaitingDonations, { donations: r }));
  assert.match(h, /<div class="row"><span>Waiting at this seat<\/span><b>1,500\.5 sat<\/b><\/div>/);
  assert.match(h, /<h3>Protocol developers<\/h3><div class="row"><span>Protocol set, serial 3 · per day \(UTC\)<\/span><b>abababababababab…<\/b>/);
  assert.match(h, /<span>dev a · 02cdcdcdcdcd…<\/span><b>1,000 sat · 2 donations<\/b>/);
  assert.match(h, /<span>dev b · devb@getalby\.com<\/span><b>500\.5 sat · 1 donation<\/b>/, 'the Lightning address when there is no key');
  assert.match(h, /<summary class="sub">1 round<\/summary><div class="row sub"><span>round efefefefefefefef…<\/span><b>500 sat<\/b>/);
  assert.equal(renderToStaticMarkup(React.createElement(WaitingDonations, { donations: { sets: [] } })), '<div class="card"><p>This node collects no donations yet.</p></div>');
  assert.equal(renderToStaticMarkup(React.createElement(WaitingDonations, { why: 'no answer' })), '<div class="card"><p class="err">no answer</p></div>');
  assert.deepEqual([sat('1'), sat('2500000')], ['0.001 sat', '2,500 sat']);
});

const client = { slug: 'deva', label: 'dev a', running: true, recipientPk: '02' + 'cd'.repeat(32), receivedMsat: '2000000', donations: 3, withdrawnMsat: '0',
  balances: [{ federation: '33'.repeat(32), msat: '2000000' }], lastPass: { at: '2026-10-21T20:00:00Z', seats: 14 }, requests: [],
  split: { protocolMsat: '1500000', games: [{ game: 'rps', title: 'Rock Paper Scissors', msat: '500000', donations: 1 }], unknownMsat: '0',
    earnings: { periods: Object.fromEntries(['day', 'week', 'month', 'year', 'all'].map((k) => [k, { protocolMsat: '1500000', games: [{ game: 'rps', title: 'Rock Paper Scissors', msat: '500000' }], unknownMsat: '0', totalMsat: '2000000' }])) },
    shares: { protocolBps: 5000, games: [{ title: 'Rock Paper Scissors', bps: 10000 }] } } };
function dev(props = {}) {
  const calls = { setup: [], withdraw: [], remove: [], reread: 0, follow: [] };
  const m = new DevClients({ dev: { managed: true, clients: [client] }, setup: async (a) => { calls.setup.push(a); return { slug: 'devb', recipientPk: '03' + 'aa'.repeat(32) }; },
    withdraw: async (a) => { calls.withdraw.push(a); if (a.invoice === 'lntbBAD') throw new Error('the client refused it'); return { id: 'w1' }; },
    remove: async (s) => { calls.remove.push(s); }, reread: () => { calls.reread++; }, follow: (s, id) => calls.follow.push([s, id]), ...props });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  return { m, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) };
}

test('a dev client: received, its split, earnings by period, holdings, withdraw open while it holds sats, setup', () => {
  const h = dev().html();
  assert.match(h, /<h3>dev a<span class="ok"> · running<\/span><\/h3>/);
  assert.match(h, /<span>For Rock Paper Scissors<\/span><b>500 sat · 1 donation<\/b>/);
  assert.match(h, /<table class="earn"><thead><tr><th><\/th><th>Today<\/th><th>This week<\/th>.*<tr><th><b>Total<\/b><\/th><td>2,000 sat<\/td>/);
  assert.match(h, /<span>Your share of the protocol developers&#x27; half<\/span><b>50 %<\/b>/);
  assert.match(h, /<span>Holds in 333333333333<\/span><b>2,000 sat<\/b>/);
  assert.match(h, /<details open=""><summary>Withdraw over Lightning<\/summary>/);
  assert.match(h, /<h3>Set up a dev client<\/h3>/);
  assert.match(dev({ dev: { managed: false, clients: [] } }).html(), /runs no dev clients of its own/);
});

test('withdraw: an invoice as it is, an address with an amount in msat; a refusal said; setup and remove hand their requests over', async () => {
  const d = dev();
  d.m.state.to.deva = 'lntb1ok'; await d.m.withdraw('deva');
  d.m.state.to.deva = 'devb@getalby.com'; d.m.state.amount.deva = '700'; await d.m.withdraw('deva');
  assert.deepEqual(d.calls.withdraw, [{ slug: 'deva', invoice: 'lntb1ok' }, { slug: 'deva', lnAddress: 'devb@getalby.com', msat: '700000' }]);
  assert.deepEqual(d.calls.follow, [['deva', 'w1'], ['deva', 'w1']]);
  assert.match(d.html(), /<div class="err" id="we-deva"><span class="ok">Asked ✓ the client pays it within seconds \(w1\)<\/span><\/div>/);
  d.m.state.to.deva = 'lntbBAD'; await d.m.withdraw('deva');
  assert.match(d.html(), /<div class="err" id="we-deva">the client refused it<\/div>/);
  d.m.state.label = ' dev b '; d.m.state.secret = 'ff'.repeat(32); await d.m.setup();
  assert.deepEqual(d.calls.setup, [{ label: 'dev b', secretHex: 'ff'.repeat(32) }]);
  assert.deepEqual([d.m.state.secret, d.m.state.setupSaid.text], ['', 'Set up ✓ devb · key 03aaaaaaaaaaaaaa…']);
  await d.m.remove('deva');
  assert.deepEqual([d.calls.remove, d.calls.reread], [['deva'], 1]);
});
