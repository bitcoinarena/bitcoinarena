// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S DONATIONS IN REACT (kanban #564): what is waiting at this seat per set, recipient (a key, or its Lightning address when
// it has none), day and round; the dev clients - earnings by period, holdings, withdraw (an invoice, or an address with an amount), remove,
// and setting one up - each handing its signed request to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingDonations, DevClients, DonationsTable, sat } from '../dist/test/donations.mjs';

test('waiting at this seat at one peek: the total in one line; only sets and recipients with something waiting, folded by day (2026-10-22)', () => {
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

test('the dev clients at one peek: a wide card - ready to withdraw in whole sats with Withdraw, four chips, the split as a bar with counts; the newest donations; the rest folded (2026-10-22)', () => {
  const h = dev().html();
  assert.match(h, /<div class="devhero"><div class="dh-top"><div class="dh-who"><b>dev a<\/b> <span class="pill on">running<\/span><div class="dh-share"><span class="sub">Your share<\/span><span><b>50 %<\/b> Protocol<\/span><span class="own"><b>100 %<\/b> Rock Paper Scissors<\/span><\/div><small>newest donation [0-9]+ (min|h|d) ago<\/small><\/div><div class="dh-cash"><span>Ready to withdraw<\/span><b>2,000 sat<\/b><button type="button" class="primary">Withdraw<\/button>/);
  assert.match(h, /<div class="dh-chips"><div><span>Today<\/span><b>2,000 sat<\/b><\/div><div><span>This week<\/span><b>2,000 sat<\/b><\/div><div><span>All time<\/span><b>2,000 sat<\/b><\/div><div><span>Donations<\/span><b>3<\/b><\/div><\/div>/);
  assert.match(h, /<div class="dh-bar"><i style="width:75%;background:var\(--st\)"><\/i><i style="width:25%;background:var\(--gv\)"><\/i><\/div><div class="dh-tip"><span class="sub">Point at the bar to see each part<\/span><\/div>/);
  assert.doesNotMatch(h, /Newest donations/, 'the ten-row list gave way to the donations table');
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
});

test('the donations table: filters for app, part, search and rows; paging; a row opens its full record; amounts in the currency (2026-10-22)', async () => {
  const asked = [];
  const row = (i, extra = {}) => ({ atMs: Date.parse('2026-10-22T15:08:00Z') - i * 60000, amountMsat: '3000', protocolMsat: '2000', appMsat: '1000', app: 'nextblock', title: 'Tick Tock, Next Block',
    market: false, item: null, round: '80b976dc184e5e9a'.padEnd(64, '0'), entry: 'e' + i, player: 'c8a6af2023b9194c'.padEnd(64, '1'), outpoint: 'o:' + i,
    fiat: { all: { chf: 0.0021 }, protocol: { chf: 0.0014 }, app: { chf: 0.0007 } }, ...extra });
  const answer = (q) => ({ ok: true, total: 60, offset: q.offset, limit: q.limit, apps: [{ app: 'nextblock', title: 'Tick Tock, Next Block', count: 50 }, { app: 'items', title: 'Items', count: 10 }],
    sums: { msat: '180000', protocolMsat: '120000', appMsat: '60000', fiat: { all: { chf: 0.13 }, protocol: { chf: 0.08 }, app: { chf: 0.05 } } },
    rows: [row(0), row(1, { item: 'turbo', round: null, app: 'nextblock' })] });
  const t = new DonationsTable({ clients: [{ slug: 'deva', label: 'dev a' }], cur: 'sat', query: async (q) => { asked.push(q); return answer(q); } });
  t.setState = function (c, then) { this.state = { ...this.state, ...(typeof c === 'function' ? c(this.state) : c) }; if (then) then(); };
  await t.load();
  const html = () => renderToStaticMarkup(t.render());
  let h = html();
  assert.deepEqual(asked[0], { slug: 'deva', app: '', q: '', limit: 10, offset: 0 }, 'ten rows by default (2026-10-22)');
  t.set({ limit: 25 }); await t.load();
  assert.match(h, /<div class="dt-sum"><b>60<\/b> donations · <b>180 sat<\/b><\/div>/);
  assert.match(h, /<option value="" selected="">All apps<\/option><option value="nextblock">Tick Tock, Next Block · 50<\/option><option value="items">Items · 10<\/option>/);
  assert.match(h, /<td class="dim">2026-10-22 15:08<\/td><td><span class="tag">Tick Tock, Next Block<\/span><\/td><td class="mono">80b976dc…0000<\/td><td class="mono">c8a6af20…1111<\/td><td class="n"><b>3 sat<\/b><\/td>/);
  assert.match(h, /<span class="tag item">item<\/span><\/td><td class="mono">turbo<\/td>/, 'an item donation names its item');
  assert.match(h, /<button type="button" disabled="">‹ Prev<\/button><span>1–10 of 60 · page 1 of 6<\/span><button type="button">Next ›<\/button>/);
  t.set({ offset: 25 }); await t.load();
  assert.deepEqual(asked.at(-1), { slug: 'deva', app: '', q: '', limit: 25, offset: 25 });
  assert.match(html(), /<span>26–50 of 60 · page 2 of 3<\/span>/);
  t.set({ app: 'items', limit: 50 }); await t.load();
  assert.deepEqual(asked.at(-1), { slug: 'deva', app: 'items', q: '', limit: 50, offset: 0 }, 'a new filter starts at the first page');
  t.state.part = 'protocol'; t.state.open = 0;
  h = html();
  assert.match(h, /<th class="n">Protocol part<\/th>/);
  assert.match(h, /<td class="n"><b>2 sat<\/b><\/td>/);
  assert.match(h, /<b>120 sat<\/b>/);
  assert.match(h, /<tr class="dt-more"><td colSpan="5"><div class="dt-rec"><div><span>Round<\/span><code>80b976dc184e5e9a0+<\/code><\/div><div><span>Entry<\/span><code>e0<\/code><\/div><div><span>Player key<\/span><code>c8a6af2023b9194c1+<\/code><\/div><div><span>Outpoint<\/span><code>o:0<\/code><\/div>/);
  t.props = { ...t.props, cur: 'chf' };
  h = html();
  assert.match(h, /<b>CHF 0.08<\/b><small> 120 sat<\/small>/);
  assert.match(h, /<td class="n"><b>CHF 0.0014<\/b><small>2 sat<\/small><\/td>/);
});

test('a market row shows its window by name, 18:45 – 19:00 UTC, and its player (kanban #580)', async () => {
  const W = { fromMs: Date.parse('2026-10-20T18:45:00Z'), toMs: Date.parse('2026-10-20T19:00:00Z') };
  const row = { atMs: Date.parse('2026-10-20T21:10:00Z'), amountMsat: '221', protocolMsat: '110', appMsat: '111', app: 'btc-updown-15m', title: 'Bitcoin Up or Down',
    market: true, item: null, round: '6c68396b'.padEnd(64, '0') + '', entry: 'e1', player: 'bb22'.padEnd(64, '3'), window: W, outpoint: 'o:1', fiat: { all: {}, protocol: {}, app: {} } };
  const t = new DonationsTable({ clients: [{ slug: 'devb', label: 'dev b' }], cur: 'sat', query: async () => ({ ok: true, total: 1, apps: [], sums: { msat: '221', protocolMsat: '110', appMsat: '111', fiat: {} }, rows: [row] }) });
  t.setState = function (c, then) { this.state = { ...this.state, ...c }; if (then) then(); };
  await t.load();
  let h = renderToStaticMarkup(t.render());
  assert.match(h, /<span class="tag">Bitcoin Up or Down<\/span><span class="tag mk">market<\/span><\/td><td class="win" title="round 6c68396b0+">18:45 – 19:00<\/td><td class="mono">bb223333…3333<\/td>/);
  t.state.open = 0;
  h = renderToStaticMarkup(t.render());
  assert.match(h, /<div><span>Market<\/span><code>2026-10-20 18:45 – 19:00 UTC<\/code><\/div><div><span>Round<\/span>/);
});

test('a market donation of several orders: "N players" in the row, each order\'s player and share in its record (kanban #580)', async () => {
  const row = { atMs: Date.parse('2026-10-22T19:10:00Z'), amountMsat: '4000', protocolMsat: '2000', appMsat: '2000', app: 'btc-updown-15m', title: 'Bitcoin Up or Down', market: true,
    item: null, round: '7'.repeat(64), entry: '9'.repeat(64), player: null, window: { fromMs: Date.parse('2026-10-22T18:45:00Z'), toMs: Date.parse('2026-10-22T19:00:00Z') },
    parts: [{ entry: 'a'.repeat(64), player: '1'.repeat(64), msat: '1000' }, { entry: 'b'.repeat(64), player: '2'.repeat(64), msat: '3000' }], outpoint: 'o:2', fiat: { all: {}, protocol: {}, app: {} } };
  const t = new DonationsTable({ clients: [{ slug: 'devb', label: 'dev b' }], cur: 'sat', query: async () => ({ ok: true, total: 1, apps: [], sums: { msat: '4000', protocolMsat: '2000', appMsat: '2000', fiat: {} }, rows: [row] }) });
  t.setState = function (c, then) { this.state = { ...this.state, ...c }; if (then) then(); };
  await t.load();
  t.state.open = 0;
  const h = renderToStaticMarkup(t.render());
  assert.match(h, /<td class="mono"><span title="1{64}\n2{64}">2 players<\/span><\/td>/);
  assert.match(h, /<div><span>Order<\/span><code>1{64} · 1 sat<\/code><\/div><div><span>Order<\/span><code>2{64} · 3 sat<\/code><\/div>/);
});
