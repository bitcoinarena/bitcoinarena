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

test('waiting at this seat at one peek: the total in one line; only sets and recipients with something waiting, folded by day (the owner 2026-10-22)', () => {
  const r = { totalMsat: '1500500', sets: [{ setId: 'ab'.repeat(32), title: 'Protocol developers', kind: 'protocol', serial: 3, recipients: [
    { label: 'dev a', key: '02' + 'cd'.repeat(32), totalMsat: '1000000', donations: 2, byDay: [{ day: '2026-10-21', msat: '1000000' }, { day: '2026-10-20', msat: '0' }], byRound: [] },
    { label: 'dev b', key: null, lnurl: 'devb@getalby.com', totalMsat: '0', donations: 0, byDay: [], byRound: [] }] },
    { setId: 'cd'.repeat(32), title: 'Protocol developers', kind: 'protocol', serial: 1, recipients: [{ label: 'recipient', lnurl: 'lnurl1x', totalMsat: '0', donations: 0, byDay: [], byRound: [] }] }] };
  const h = renderToStaticMarkup(React.createElement(WaitingDonations, { donations: r }));
  assert.match(h, /<div class="row"><span>Waiting at this seat for the dev clients<\/span><b>1,500\.5 sat<\/b><\/div>/);
  assert.match(h, /<summary class="sub">By set and day<\/summary><div><h4>Protocol developers · protocol set 3<\/h4><div class="row"><span>dev a · 2 donations<\/span><b>1,000 sat<\/b><\/div><div class="row sub"><span>2026-10-21<\/span><b>1,000 sat<\/b><\/div><\/div><\/details>/);
  assert.doesNotMatch(h, /dev b|protocol set 1|2026-10-20/, 'nothing at 0 is drawn');
  const none = renderToStaticMarkup(React.createElement(WaitingDonations, { donations: { totalMsat: '0', sets: [] } }));
  assert.match(none, /<b><span class="ok">nothing · all collected<\/span><\/b>/);
  assert.doesNotMatch(none, /<details/);
  assert.equal(renderToStaticMarkup(React.createElement(WaitingDonations, { why: 'no answer' })), '<div class="card"><p class="err">no answer</p></div>');
  assert.deepEqual([sat('1'), sat('2500000')], ['0.001 sat', '2,500 sat']);
});

const client = { slug: 'deva', label: 'dev a', running: true, recipientPk: '02' + 'cd'.repeat(32), receivedMsat: '2000000', donations: 3, withdrawnMsat: '0',
  balances: [{ federation: '33'.repeat(32), msat: '2000000' }, { federation: '44'.repeat(32), msat: '0' }], lastPass: { at: '2026-10-21T20:00:00Z', seats: 14 }, requests: [],
  recent: [{ round: '80b976dc184e5e9a'.padEnd(64, '0'), entry: 'e1', federation: '33'.repeat(32), amountMsat: '2668', contract: 'c1', atMs: Date.parse('2026-10-22T15:08:00Z'), player: 'c8a6af2023b9194c'.padEnd(64, '1') }],
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

test('the dev clients at one peek: a wide card - ready to withdraw in whole sats with Withdraw, four chips, the split as a bar with counts; the newest donations; the rest folded (the owner 2026-10-22)', () => {
  const h = dev().html();
  assert.match(h, /<div class="devhero"><div class="dh-top"><div class="dh-who"><b>dev a<\/b> <span class="pill on">running<\/span><div class="dh-share"><span class="sub">Your share<\/span><span><b>50 %<\/b> Protocol<\/span><span class="own"><b>100 %<\/b> Rock Paper Scissors<\/span><\/div><small>newest donation [0-9]+ (min|h|d) ago<\/small><\/div><div class="dh-cash"><span>Ready to withdraw<\/span><b>2,000 sat<\/b><button type="button" class="primary">Withdraw<\/button>/);
  assert.match(h, /<div class="dh-chips"><div><span>Today<\/span><b>2,000 sat<\/b><\/div><div><span>This week<\/span><b>2,000 sat<\/b><\/div><div><span>All time<\/span><b>2,000 sat<\/b><\/div><div><span>Donations<\/span><b>3<\/b><\/div><\/div>/);
  assert.match(h, /<div class="dh-bar"><i style="width:75%;background:var\(--st\)"><\/i><i style="width:25%;background:var\(--gv\)"><\/i><\/div><div class="dh-tip"><span class="sub">Point at the bar to see each part<\/span><\/div>/);
  assert.match(h, /<h3>Newest donations<\/h3>.*<td>10-22 15:08<\/td><td>dev a<\/td><td class="n">2,668 msat<\/td><td title="80b976dc[0-9a-f]+">80b976dc18…<\/td><td title="c8a6af[0-9a-f]+">c8a6af2023…<\/td>/);
  assert.match(h, /<details><summary>dev a: details, remove<\/summary><div class="card"><h3>dev a<span class="ok"> · running<\/span><\/h3>/);
  assert.match(h, /<span>Holds in 333333333333<\/span><b>2,000 sat<\/b>/);
  assert.doesNotMatch(h, /Holds in 444444444444/, 'a federation holding 0 is not drawn');
  assert.match(h, /<summary class="sub">Add a dev client<\/summary>/);
  assert.match(dev({ dev: { managed: false, clients: [] } }).html(), /runs no dev clients of its own/);
});

test('withdraw: an invoice as it is, an address with an amount in msat; a refusal said; setup and remove hand their requests over', async () => {
  const d = dev();
  d.m.state.wd = { deva: true };   // the card's Withdraw opens the form in the card
  assert.match(d.html(), /<div class="dh-withdraw"><label>A Lightning invoice/);
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

test('each part counted: the protocol line its donations, a game its rounds or market rounds and its items, each item on its own row (kanban #578)', () => {
  const split = { protocolMsat: '157125000', protocolDonations: 69, unknownMsat: '0',
    games: [{ game: 'nextblock', title: 'Tick Tock, Next Block', msat: '141987000', donations: 51, rounds: 40, items: 11, market: false,
      itemsBy: [{ item: 'turbo', donations: 7, msat: '9000000' }, { item: 'shield', donations: 4, msat: '3000000' }] },
      { game: 'btc-updown', title: 'Bitcoin Up or Down', msat: '1263000', donations: 8, rounds: 6, items: 0, market: true, itemsBy: [] }] };
  const h = dev({ dev: { managed: true, clients: [{ ...client, split: { ...client.split, ...split }, recent: [{ round: '0'.repeat(64), item: 'Tick Tock, Next Block · turbo', amountMsat: '600', atMs: 0, player: '' }] }] } }).html();
  assert.match(h, /<span>Protocol<\/span><b>157,125 sat<\/b><small>69 donations<\/small>/);
  assert.match(h, /<span>Tick Tock, Next Block<\/span><b>141,987 sat<\/b><small>51 donations · 40 rounds · 11 items<\/small>/);
  assert.match(h, /<h4>Items · Tick Tock, Next Block<\/h4><div class="row sub"><span>turbo<\/span><b>9,000 sat · 7 times<\/b><\/div><div class="row sub"><span>shield<\/span><b>3,000 sat · 4 times<\/b>/);
  assert.match(h, /<span>Bitcoin Up or Down<\/span><b>1,263 sat<\/b><small>8 donations · 6 market rounds<\/small>/);
  assert.match(h, /<td title="Tick Tock, Next Block · turbo">Tick Tock, Next Block · turbo<\/td>/, 'an item donation names its item, not a round');
});

test('amounts in a currency: the switch, each chip at the donations own rates, what is held at the price now, a column per donation (kanban #578)', () => {
  const fiat = { now: { eur: 70000, usd: 80000, chf: 66000, gbp: 60000 }, unrated: { eur: 0, usd: 0, chf: 0, gbp: 0 },
    totals: { day: { eur: 1.4, usd: 1.6, chf: 1.32, gbp: 1.2 }, week: { eur: 1.4, usd: 1.6, chf: 1.32, gbp: 1.2 }, all: { eur: 1.4, usd: 1.6, chf: 1.32, gbp: 1.2 } },
    recent: { 'o:1': { eur: 0.0019, usd: 0.0021, chf: 0.0018, gbp: 0.0016 } } };
  const d = dev({ dev: { managed: true, clients: [{ ...client, fiat, recent: [{ ...client.recent[0], outpoint: 'o:1' }] }] } });
  let h = d.html();
  assert.match(h, /<div class="cur-pick"><span>Show amounts in<\/span><button type="button" class="on">sat<\/button><button type="button">EUR<\/button>/);
  d.m.state.cur = 'chf';
  h = d.html();
  assert.match(h, /<span>Ready to withdraw<\/span><b>CHF 1.32<\/b><small>2,000 sat at today&#x27;s price<\/small>/);
  assert.match(h, /<div><span>All time<\/span><b>CHF 1.32<\/b><small>2,000 sat<\/small><\/div>/);
  assert.match(h, /<th class="n">CHF then<\/th>/);
  assert.match(h, /<td class="n">2,668 msat<\/td><td class="n">CHF 0.0018<\/td>/);
});
