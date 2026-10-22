// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S OWN DEV CLIENTS: set up from the owner page with a new or an imported key, run as children, a withdrawal
// left for the client, removal that keeps the key - and each donation split into the protocol developers' part and its game's part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createDevClients, attributeDonations, devEarnings, donationParts, donationsPage, slugOf } from '../src/dev-clients.js';
import { newKey, keyFromSecret } from '../../arena-donor/src/donor.js';

const fakeSpawn = () => {
  const started = [];
  const spawn = (bin, args) => { const c = new EventEmitter(); c.pid = 1000 + started.length; c.kill = () => { c.emit('exit', null, 'SIGTERM'); }; started.push({ bin, args, c }); return c; };
  return { spawn, started };
};
const make = (over = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'dev358-'));
  const f = fakeSpawn();
  const d = createDevClients({ root, donorBin: '/x/arena-donor.mjs', nodeBin: '/x/node', keys: { newKey, keyFromSecret }, spawn: f.spawn, restartMs: 10,
    defaults: { wasmPkg: '/x/wasm', seats: ['http://s1', 'http://s2'], invitesFrom: ['https://t/daily.json'], gateways: ['https://gw/'] }, ...over });
  return { root, d, f };
};

test('a new key: its directory, key.json readable by the node only, donor.json from the node\'s knowledge, and the client started', () => {
  const { root, d, f } = make();
  const r = d.setup({ label: 'Dev A' });
  assert.equal(r.ok, true); assert.equal(r.slug, 'dev-a'); assert.equal(r.imported, false);
  const key = JSON.parse(readFileSync(join(root, 'dev-a', 'key.json'), 'utf8'));
  assert.equal(statSync(join(root, 'dev-a', 'key.json')).mode & 0o777, 0o600);
  assert.equal(key.recipientPkHex, r.recipientPk);
  const cfg = JSON.parse(readFileSync(join(root, 'dev-a', 'donor.json'), 'utf8'));
  assert.deepEqual([cfg.seats, cfg.invitesFrom, cfg.gateways, cfg.wasmPkg, cfg.imported, cfg.lnd], [['http://s1', 'http://s2'], ['https://t/daily.json'], ['https://gw/'], '/x/wasm', false, undefined]);
  assert.deepEqual(f.started[0].args, ['/x/arena-donor.mjs', 'loop', join(root, 'dev-a')]);
  assert.equal(d.list()[0].running, true);
});

test('an imported key recovers (imported: true), and a second client on the same key or label is refused', () => {
  const { d } = make();
  const k = newKey();
  const r = d.setup({ label: 'dev b', secretHex: k.secretHex });
  assert.equal(r.ok, true); assert.equal(r.recipientPk, k.recipientPkHex); assert.equal(r.imported, true);
  assert.match(d.setup({ label: 'dev b2', secretHex: k.secretHex }).why, /already has a client/);
  assert.match(d.setup({ label: 'dev b' }).why, /exists/);
  assert.match(d.setup({ label: 'x', secretHex: 'zz' }).why, /64 hex/);
  assert.match(d.setup({ label: '!!!' }).why, /letters and digits/);
});

test('without a lock client the node runs no dev clients and says so', () => {
  const { d } = make({ defaults: {} });
  assert.equal(d.setup({ label: 'a' }).status, 501);
});

test('a withdrawal is left for the client once; an invoice or an address, nothing else', () => {
  const { root, d } = make();
  d.setup({ label: 'a' });
  assert.match(d.withdraw({ slug: 'a' }).why, /invoice or a Lightning address/);
  assert.match(d.withdraw({ slug: 'a', invoice: 'bitcoin:x' }).why, /not a Lightning invoice/);
  assert.match(d.withdraw({ slug: 'a', lnAddress: 'nope' }).why, /name@domain/);
  assert.equal(d.withdraw({ slug: 'zz', invoice: 'lntb1u1pqq' }).status, 404);
  const w = d.withdraw({ slug: 'a', invoice: 'lntb1u1pqq' });
  assert.equal(w.ok, true);
  const q = JSON.parse(readFileSync(join(root, 'a', 'withdraw-request.json'), 'utf8'));
  assert.deepEqual([q.id, q.invoice], [w.id, 'lntb1u1pqq']);
  assert.equal(d.withdraw({ slug: 'a', lnAddress: 'dev@pay.example', msat: '5000' }).status, 409);
  assert.equal(d.list()[0].waiting, true);
  // the client's answer is shown, newest first
  writeFileSync(join(root, 'a', 'state.json'), JSON.stringify({ requests: [{ id: 'old', state: 'Success' }, { id: w.id, state: 'Paying' }] }));
  assert.deepEqual(d.list()[0].requests.map((x) => x.id), [w.id, 'old']);
});

test('removing stops the client and keeps its directory and key; a stopped client is started again', async () => {
  const { root, d, f } = make();
  d.setup({ label: 'a' });
  f.started[0].c.emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.started.length, 2, 'restarted after it stopped on its own');
  const r = d.remove({ slug: 'a' });
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(root, r.kept, 'key.json')));
  assert.deepEqual(d.list(), []);
  await new Promise((r2) => setTimeout(r2, 40));
  assert.equal(f.started.length, 2, 'a removed client is not started again');
  assert.equal(readdirSync(root).length, 1);
});

test('each donation is split p : g between the protocol developers and its game; an unknown round is counted apart', () => {
  const games = { r1: { name: 'nextblock', title: 'Tick Tock', bps: 6667 }, r2: { name: 'rock-paper-scissors', title: 'RPS', bps: 6667 } };
  const s = attributeDonations([{ roundId: 'r1', amountMsat: '1000' }, { roundId: 'r2', amountMsat: '3000' }, { roundId: 'r9', amountMsat: '7' }],
    { protocolBps: 6667, gameOf: (rid) => games[rid] || null });
  assert.equal(s.protocolMsat, '2000');
  assert.deepEqual(s.games.map((g) => [g.game, g.msat, g.donations]), [['nextblock', '500', 1], ['rock-paper-scissors', '1500', 1]]);
  assert.equal(s.unknownMsat, '7');
  // a key only in the game's set: all of it is the game's
  const g = attributeDonations([{ roundId: 'r1', amountMsat: '900' }], { protocolBps: 0, gameOf: () => ({ name: 'nextblock', bps: 5000 }) });
  assert.deepEqual([g.protocolMsat, g.games[0].msat], ['0', '900']);
});

test('labels become directory names', () => {
  assert.equal(slugOf(' Dev A! '), 'dev-a');
  assert.equal(slugOf('../../etc'), 'etc');
});

test('a dev key\'s earnings by period: today, this week from Monday, this month, this year, all time, and day by day', () => {
  // Thursday 2026-10-15 12:00Z; the week began Monday 10-12
  const nowMs = Date.UTC(2026, 9, 15, 12);
  const at = (y, m, d, h = 10) => Date.UTC(y, m - 1, d, h);
  const rows = [
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 10, 15) },   // today
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 10, 12, 0) }, // Monday: this week
    { roundId: 'rps', amountMsat: '1000', verifiedMs: at(2026, 10, 11) },  // Sunday: last week, this month
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 9, 30) },    // September: this year
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2025, 12, 31) },   // last year
    { roundId: 'gone', amountMsat: '500', verifiedMs: at(2026, 10, 15) },  // a round this node no longer holds
  ];
  const games = { tt: { name: 'nextblock', title: 'Tick Tock', bps: 3333 }, rps: { name: 'rock-paper-scissors', title: 'RPS', bps: 10000 } };
  const e = devEarnings(rows, { protocolBps: 6667, gameOf: (r) => games[r] || null, nowMs, days: 7 });
  const part = (k) => ({ p: e.periods[k].protocolMsat, tt: (e.periods[k].games.find((g) => g.game === 'nextblock') || {}).msat || '0',
    rps: (e.periods[k].games.find((g) => g.game === 'rock-paper-scissors') || {}).msat || '0', u: e.periods[k].unknownMsat, t: e.periods[k].totalMsat });
  // 3000 split 6667 : 3333 -> 2000 protocol, 1000 game; 1000 for RPS split 6667 : 10000 -> 400 protocol, 600 game
  assert.deepEqual(part('day'), { p: '2000', tt: '1000', rps: '0', u: '500', t: '3500' });
  assert.deepEqual(part('week'), { p: '4000', tt: '2000', rps: '0', u: '500', t: '6500' });
  assert.deepEqual(part('month'), { p: '4400', tt: '2000', rps: '600', u: '500', t: '7500' });
  assert.deepEqual(part('year'), { p: '6400', tt: '3000', rps: '600', u: '500', t: '10500' });
  assert.deepEqual(part('all'), { p: '8400', tt: '4000', rps: '600', u: '500', t: '13500' });
  assert.deepEqual(e.days.map((d) => d.day), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
  assert.deepEqual(e.days.map((d) => d.totalMsat), ['0', '0', '1000', '3000', '0', '0', '3500']);
});

test('the counts at one peek: protocol donations, rounds or market rounds per game, items grouped by game and item (kanban #578)', async () => {
  const { attributeDonations } = await import('../src/dev-clients.js');
  const Z = '0'.repeat(64);
  const rows = [
    { roundId: 'a1'.repeat(32), amountMsat: '1000' }, { roundId: 'a1'.repeat(32), amountMsat: '1000' }, { roundId: 'a2'.repeat(32), amountMsat: '1000' },
    { roundId: 'b1'.repeat(32), amountMsat: '2000' },
    { roundId: Z, entryId: 'p1', amountMsat: '600', item: 'Tick Tock, Next Block · turbo', itemGame: 'Tick Tock, Next Block', itemId: 'turbo' },
    { roundId: Z, entryId: 'p2', amountMsat: '600', item: 'Tick Tock, Next Block · turbo', itemGame: 'Tick Tock, Next Block', itemId: 'turbo' },
    { roundId: Z, entryId: 'p3', amountMsat: '900', item: 'Tick Tock, Next Block · shield', itemGame: 'Tick Tock, Next Block', itemId: 'shield' },
    { roundId: Z, entryId: 'old', amountMsat: '300' },                     // an older item row without itemGame: found by its purchase
    { roundId: 'ff'.repeat(32), amountMsat: '50' },                        // a round no game here holds
  ];
  const nb = { name: 'nextblock', title: 'Tick Tock, Next Block', bps: 5000, market: false };
  const ud = { name: 'btc-updown', title: 'Bitcoin Up or Down', bps: 5000, market: true };
  const gameOf = (rid) => (rid.startsWith('a') ? nb : rid.startsWith('b') ? ud : null);
  const r = attributeDonations(rows, { protocolBps: 5000, gameOf, gameByName: (n) => (n === 'Tick Tock, Next Block' ? nb : null), itemOf: (id) => (id === 'old' ? nb : null) });
  assert.equal(r.protocolDonations, 8, 'every donation that paid the protocol part');
  const g = Object.fromEntries(r.games.map((x) => [x.game, x]));
  assert.deepEqual([g.nextblock.donations, g.nextblock.rounds, g.nextblock.items, g.nextblock.market], [7, 2, 4, false]);
  assert.deepEqual([g['btc-updown'].rounds, g['btc-updown'].market, g['btc-updown'].items], [1, true, 0], 'a market counts its market rounds');
  assert.deepEqual(g.nextblock.itemsBy, [{ item: 'shield', donations: 1, msat: '450' }, { item: 'turbo', donations: 2, msat: '600' }, { item: 'an item', donations: 1, msat: '150' }]
    .sort((a, b) => Number(b.msat) - Number(a.msat)));
  assert.equal(r.unknownMsat, '50');
});

test('the donations table: each row split as the earnings are; filtered by app (its items with it) or items, searched, paged, summed in msat and at each row\'s own rate (kanban #578)', () => {
  const games = { r1: { name: 'nextblock', title: 'Tick Tock, Next Block', bps: 5000 }, r2: { name: 'btc-updown', title: 'Bitcoin Up or Down', bps: 5000, market: true } };
  const rows = [
    { roundId: 'r1', entryId: 'e1', amountMsat: '3000', outpoint: 'o1', playerKey: 'aa11', verifiedMs: 1000 },
    { roundId: 'r2', entryId: 'e2', amountMsat: '2000', outpoint: 'o2', playerKey: 'bb22', verifiedMs: 3000 },
    { roundId: '0'.repeat(64), entryId: 'p1', amountMsat: '1000', outpoint: 'o3', playerKey: 'aa11', verifiedMs: 2000, item: 'Tick Tock, Next Block · turbo', itemGame: 'nextblock', itemId: 'turbo' },
    { roundId: 'gone', entryId: 'e4', amountMsat: '4000', outpoint: 'o4', verifiedMs: 500 }];
  const info = donationParts(rows, { protocolBps: 5000, gameOf: (id) => games[id] || null, gameByName: (n) => Object.values(games).find((g) => g.name === n) || null });
  assert.deepEqual(info.map((x) => [x.game, x.item, String(x.protocolMsat), String(x.appMsat)]),
    [['nextblock', null, '1500', '1500'], ['btc-updown', null, '1000', '1000'], ['nextblock', 'turbo', '500', '500'], [null, null, '0', '0']]);
  const rates = { o1: { eur: 100000 }, o3: { eur: 50000 } };
  const all = donationsPage(info, rates);
  assert.deepEqual(all.apps, [{ app: 'nextblock', title: 'Tick Tock, Next Block', market: false, count: 2 }, { app: 'btc-updown', title: 'Bitcoin Up or Down', market: true, count: 1 },
    { app: 'items', title: 'Items (all apps)', market: false, count: 1 }, { app: 'unknown', title: 'Older rounds', market: false, count: 1 }]);
  assert.deepEqual(all.rows.map((r) => r.outpoint), ['o2', 'o3', 'o1', 'o4'], 'newest first');
  assert.deepEqual([all.total, all.sums.msat, all.sums.protocolMsat, all.sums.appMsat], [4, '10000', '3000', '3000']);
  assert.deepEqual(all.sums.fiat.all, { eur: 0.0035 }, 'a testnet sum is a fraction of a cent: 4 decimals kept');
  const nb = donationsPage(info, rates, { app: 'nextblock' });
  assert.deepEqual(nb.rows.map((r) => [r.outpoint, r.item, r.round]), [['o3', 'turbo', null], ['o1', null, 'r1']], 'an app with its items');
  assert.deepEqual(nb.rows[1].fiat, { all: { eur: 0.003 }, protocol: { eur: 0.0015 }, app: { eur: 0.0015 } });
  assert.deepEqual(donationsPage(info, rates, { app: 'items' }).rows.map((r) => r.outpoint), ['o3']);
  assert.deepEqual(donationsPage(info, rates, { app: 'unknown' }).rows.map((r) => r.outpoint), ['o4']);
  assert.deepEqual(donationsPage(info, rates, { q: 'AA11' }).rows.map((r) => r.outpoint), ['o3', 'o1'], 'the search ignores case');
  assert.deepEqual(donationsPage(info, rates, { q: 'turbo' }).rows.map((r) => r.outpoint), ['o3']);
  const many = donationParts(Array.from({ length: 12 }, (_, i) => ({ roundId: 'r1', entryId: 'x' + i, amountMsat: '1000', outpoint: 'm' + i, verifiedMs: i })), { protocolBps: 5000, gameOf: (id) => games[id] });
  const p2 = donationsPage(many, {}, { limit: 5, offset: 5 });
  assert.deepEqual([p2.total, p2.limit, p2.offset, p2.rows.map((r) => r.outpoint)], [12, 5, 5, ['m6', 'm5', 'm4', 'm3', 'm2']]);
  assert.equal(donationsPage(many, {}, { limit: 1000 }).limit, 200);
});

test('a market donation names its window and its player (kanban #580): the window from the round, the player from its entry when the row names none', () => {
  const games = { m1: { name: 'btc-updown-15m', title: 'Bitcoin Up or Down', bps: 5000, market: true }, g1: { name: 'nextblock', title: 'Tick Tock, Next Block', bps: 5000 } };
  const W = { fromMs: Date.parse('2026-10-22T18:45:00Z'), toMs: Date.parse('2026-10-22T19:00:00Z') };
  const rows = [
    { roundId: 'm1', entryId: 'e1', amountMsat: '221', outpoint: 'o1', verifiedMs: 2 },
    { roundId: 'g1', entryId: 'e2', amountMsat: '1332', outpoint: 'o2', playerKey: 'aa11', verifiedMs: 1 }];
  const info = donationParts(rows, { protocolBps: 5000, gameOf: (id) => games[id] || null, windowOf: (rid) => (rid === 'm1' ? W : { fromMs: 0, toMs: 1 }),
    playerOf: (r) => r.playerKey || ({ e1: 'bb22' })[r.entryId] || null });
  assert.deepEqual(info.map((x) => [x.game, x.window, x.player]), [['btc-updown-15m', W, 'bb22'], ['nextblock', null, 'aa11']], 'only a market round names a window');
  const page = donationsPage(info, {});
  assert.deepEqual(page.rows.map((r) => [r.app, r.window, r.player]), [['btc-updown-15m', W, 'bb22'], ['nextblock', null, 'aa11']]);
  assert.deepEqual(donationsPage(info, {}, { q: 'BB22' }).rows.map((r) => r.outpoint), ['o1'], 'searched by the player found from the entry');
});

test('a market donation\'s parts reach the table: each order\'s entry, player and share, and the search finds every order\'s player (kanban #580)', () => {
  const rows = [{ roundId: 'm1', entryId: 'x', amountMsat: '4000', outpoint: 'o1', verifiedMs: 1,
    parts: [{ entryId: 'e1', playerKey: 'p1', msat: '1000' }, { entryId: 'e2', playerKey: 'p2', msat: '3000' }] }];
  const info = donationParts(rows, { protocolBps: 5000, gameOf: () => ({ name: 'btc-updown-15m', title: 'Bitcoin Up or Down', bps: 5000, market: true }) });
  const page = donationsPage(info, {});
  assert.deepEqual(page.rows[0].parts, [{ entry: 'e1', player: 'p1', msat: '1000' }, { entry: 'e2', player: 'p2', msat: '3000' }]);
  assert.deepEqual(donationsPage(info, {}, { q: 'p2' }).rows.map((r) => r.outpoint), ['o1']);
});
