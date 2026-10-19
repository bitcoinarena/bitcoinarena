// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON BOARD'S LINES (kanban #362, docs/PLATFORM-RESEARCH.md item 1): what the page draws from a seat's
// GET /season?scope=network answer. The net in whole sats from msat strings - signed, never a float, the magnitude rounded
// down; the best score in the game's own unit; the header line; the viewer's own row marked (and drawn below the top when
// it ranks further down); an empty board said in words; an answer that is not a board refused by name, so the page asks
// the next seat - and the ask itself, which falls through a seat that fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { seasonView, seasonSats, seasonScore, seasonPath, fetchSeason, SEASON_DAYS_CHOICES, SEASON_POLL_MS } from '../src/season-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ME = key(0xb2);
const row = (rank, player, over = {}) => ({ rank, player, name: `player-${rank}`, rounds: 3, wins: 1, netMsat: '0', stakedMsat: '3000',
  paidMsat: '3000', bestScore: null, lastPlayed: '2026-10-14T12:00:00.000Z', ...over });
// an answer as server.js seasonBody + seasonNetwork write it
const answer = (rows, over = {}) => ({ node: key(0x01), game: { name: 'nextblock', ids: [key(0x0a)] }, days: 7,
  from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z', fromMs: 1, toMs: 2, rows, rounds: 41, leftOut: 2, unchecked: [],
  scope: 'network', agree: 3, seats: { asked: 12, answered: 12 }, ...over });

test('msat to sats: signed, whole sats with the magnitude rounded down, never a float', () => {
  assert.equal(seasonSats('12000'), '+12 sat');
  assert.equal(seasonSats('12999'), '+12 sat', 'a win is never shown larger than it was');
  assert.equal(seasonSats('-1999'), '-1 sat', 'nor a loss: -1,999 msat is -1 sat, not -2');
  assert.equal(seasonSats('-1000'), '-1 sat');
  assert.equal(seasonSats('-999'), '0 sat', 'under a sat either way is 0 sat, with no sign');
  assert.equal(seasonSats('0'), '0 sat');
  assert.equal(seasonSats('1234567000'), '+1,234,567 sat');
  // past 2^53 msat a Number would round; the string is read as a BigInt
  assert.equal(seasonSats('9007199254740993001'), '+9,007,199,254,740,993 sat');
  assert.equal(seasonSats(5000n), '+5 sat');
  for (const bad of ['1.5', '1e3', '', ' ', 'abc', 1.5, NaN, null, undefined]) assert.equal(seasonSats(bad), null, `${bad} read as msat`);
});

test('the best score in the game\'s unit: Tick Tock\'s 1e-5 points as its result card prints them, any other game as signed', () => {
  assert.equal(seasonScore(8304450, 'nextblock'), '83.04450');
  assert.equal(seasonScore(100000000, 'nextblock'), '1000.00000');
  assert.equal(seasonScore(7, 'nextblock'), '0.00007');
  assert.equal(seasonScore(-250000, 'nextblock'), '-2.50000');
  assert.equal(seasonScore(3, 'rps'), '3');
  assert.equal(seasonScore(null, 'nextblock'), '–', 'a market\'s pick has no score');
  assert.equal(seasonScore(1.5, 'rps'), '–');
});

test('the rows and the header: the seat\'s order and names, the net in sats, the nodes it came from', () => {
  const v = seasonView(answer([
    row(2, key(0x22), { netMsat: '1500', wins: 0, bestScore: 8304450 }),
    row(1, key(0x11), { name: 'satoshi', rounds: 12, wins: 9, netMsat: '42000', bestScore: 100000000 }),
    row(3, key(0x33), { name: '', netMsat: '1000' }),
  ]), { title: 'Tick Tock, Next Block' });
  assert.equal(v.ok, true);
  assert.equal(v.header, 'Tick Tock, Next Block · last 7 days · 3 players ahead · from 13 of 13 nodes');
  assert.deepEqual(v.rows.map((r) => [r.rank, r.name, r.rounds, r.wins, r.net, r.sign, r.best]), [
    [1, 'satoshi', 12, 9, '+42 sat', 1, '1000.00000'],
    [2, 'player-2', 3, 0, '+1 sat', 1, '83.04450'],
    [3, key(0x33).slice(0, 8), 3, 1, '+1 sat', 1, '–'],      // no name: its key's first 8, as the result card
  ]);
  assert.deepEqual(v.rows.map((r) => r.netMsat), ['42000', '1500', '1000'], 'the exact msat stays on the row');
  assert.equal(v.foot, '41 rounds counted · 2 left out (not final yet, or fewer than 3 nodes agreed) · a round counts once 3 nodes hold the same account of it');
  assert.equal(v.mine, null);
  assert.equal(v.empty, null);
  // a seat that merged fewer seats says so; the game's name when no title is given; one day and one player
  const w = seasonView(answer([row(1, key(0x11), { netMsat: '5000' })], { days: 1, seats: { asked: 12, answered: 4 } }));
  assert.equal(w.header, 'nextblock · last day · 1 player ahead · from 5 of 13 nodes');
  // a seat's own board (no scope) is one node's word
  const own = seasonView(answer([row(1, key(0x11), { netMsat: '5000' })], { scope: undefined, seats: undefined, days: 30 }), { title: 'Rock Paper Scissors' });
  assert.equal(own.header, 'Rock Paper Scissors · last 30 days · 1 player ahead · from one node only');
});

test('only the players ahead are drawn (kanban #367): a net of 0 or below is left out, the viewer\'s own row too', () => {
  const v = seasonView(answer([
    row(1, key(0x11), { netMsat: '42000' }),
    row(2, key(0x22), { netMsat: '1' }),                      // 1 msat ahead is ahead, though it shows as "0 sat"
    row(3, key(0x33), { netMsat: '0' }),
    row(4, ME, { netMsat: '-999' }),
    row(5, key(0x55), { netMsat: '-20000' }),
  ]), { title: 'T', viewer: ME });
  assert.deepEqual(v.rows.map((r) => [r.rank, r.netMsat]), [[1, '42000'], [2, '1']]);
  assert.equal(v.players, 2);
  assert.equal(v.behind, 3);
  assert.equal(v.mine, null, 'the viewer behind is not drawn, not even below the top');
  assert.equal(v.more, 0);
  assert.equal(v.header, 'T · last 7 days · 2 players ahead · from 13 of 13 nodes');
  const none = seasonView(answer([row(1, key(0x11), { netMsat: '0' }), row(2, key(0x22), { netMsat: '-5000' })]), { title: 'Up or Down' });
  assert.deepEqual([none.rows, none.players, none.behind], [[], 0, 2]);
  assert.equal(none.empty, 'Nobody is ahead at Up or Down in the last 7 days.');
});

test('the viewer\'s own row is marked, and drawn below the top rows when it ranks further down', () => {
  const rows = Array.from({ length: 150 }, (_, i) => row(i + 1, key(i + 1), { netMsat: String((200 - i) * 1000) }));
  const top = seasonView(answer(rows), { viewer: key(3).toUpperCase() });
  assert.equal(top.rows.length, 100);
  assert.deepEqual(top.rows.filter((r) => r.mine).map((r) => r.rank), [3], 'its key in any case');
  assert.equal(top.mine.rank, 3);
  assert.equal(top.more, 50);
  const far = seasonView(answer(rows), { viewer: [ME, key(140)] });
  assert.equal(far.rows.length, 101);
  assert.deepEqual(far.rows.at(-1), { ...far.mine, mine: true });
  assert.equal(far.rows.at(-1).rank, 140);
  assert.equal(far.more, 49, 'the 50 below the top, the viewer\'s own not among them');
  assert.equal(seasonView(answer(rows), { viewer: ME }).mine, null, 'a viewer not on the board marks nothing');
  assert.equal(seasonView(answer(rows), { viewer: 'not a key' }).rows.some((r) => r.mine), false);
});

test('an empty board is said in words, not drawn as nothing', () => {
  const v = seasonView(answer([], { rounds: 0, leftOut: 0 }), { title: 'Up or Down' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows, []);
  assert.equal(v.players, 0);
  assert.equal(v.header, 'Up or Down · last 7 days · 0 players ahead · from 13 of 13 nodes');
  assert.equal(v.empty, 'Nobody has a counted round of Up or Down in the last 7 days.');
  assert.equal(v.foot, '0 rounds counted · a round counts once 3 nodes hold the same account of it');
});

test('an answer that is not a board is refused by name', () => {
  const cases = [
    [null, /not a season/], ['text', /not a season/], [[], /not a season/], [{ days: 7 }, /lists no rows/],
    [answer([], { days: 0 }), /window of 1 to 90 days/], [answer([], { days: 91 }), /window/],
    [answer([row(1, 'nope')]), /no 32-byte player key/],
    [answer([row(0, key(1))]), /has no rank/],
    [answer([row(1, key(1), { rounds: -1 })]), /counts no rounds or wins/],
    [answer([row(1, key(1), { netMsat: '1.5' })]), /no whole msat/],
    [answer([row(1, key(1), { netMsat: 1.5 })]), /no whole msat/],
    [answer([row(1, key(1), { netMsat: undefined })]), /no whole msat/],
    [answer([row(1, key(1), { bestScore: 0.5 })]), /best score/],
  ];
  for (const [a, why] of cases) {
    const v = seasonView(a);
    assert.equal(v.ok, false, JSON.stringify(a));
    assert.match(v.why, why);
  }
});

test('the ask: the game by name, the window, the network scope; a failed seat falls through to the next', async () => {
  assert.equal(seasonPath('Tick Tock', 30), '/season?game=Tick%20Tock&days=30&scope=network');
  assert.deepEqual(SEASON_DAYS_CHOICES, [7, 30, 90]);
  assert.equal(SEASON_POLL_MS, 30000, 'the seat keeps a season 30 s');
  const asked = [];
  const good = answer([row(1, ME, { netMsat: '5000' })]);
  const fetch = async (url) => {
    asked.push(url);
    if (url.startsWith('https://down.example')) throw new Error('network down');
    if (url.startsWith('https://busy.example')) return { ok: false, status: 503 };
    if (url.startsWith('https://odd.example')) return { ok: true, status: 200, json: async () => ({ rows: 'no' }) };
    return { ok: true, status: 200, json: async () => good };
  };
  const v = await fetchSeason({ nodes: ['https://down.example/', 'https://busy.example', 'ws://not-http', 'https://odd.example', 'https://good.example', 'https://later.example'],
    game: 'nextblock', days: 7, title: 'Tick Tock, Next Block', viewer: ME, fetch, via: (u) => u.replace('good.example', 'good.example/route') });
  assert.equal(v.ok, true);
  assert.equal(v.seat, 'https://good.example');
  assert.equal(v.mine.net, '+5 sat');
  assert.deepEqual(asked, ['https://down.example/season?game=nextblock&days=7&scope=network', 'https://busy.example/season?game=nextblock&days=7&scope=network',
    'https://odd.example/season?game=nextblock&days=7&scope=network', 'https://good.example/route/season?game=nextblock&days=7&scope=network'],
    'in order, through the route, stopping at the first board; a seat that is no http address is not asked');
  const none = await fetchSeason({ nodes: ['https://down.example', 'https://busy.example'], game: 'nextblock', days: 7, fetch });
  assert.equal(none.ok, false);
  assert.deepEqual(none.tried.map((t) => t.why), ['network down', 'answered 503']);
  assert.equal((await fetchSeason({ nodes: [], game: 'nextblock', days: 7, fetch })).why, 'no node to ask');
  assert.match((await fetchSeason({ nodes: ['https://good.example'], game: 'nextblock', days: 91, fetch })).why, /1 to 90/);
});

test('the bundle carries the season view under the names the page calls', () => {
  const bundle = createRequire(import.meta.url)('../dist/arena-client.js');
  for (const name of ['seasonView', 'fetchSeason', 'seasonPath', 'seasonSats', 'seasonScore', 'SEASON_DAYS_CHOICES', 'SEASON_POLL_MS'])
    assert.ok(bundle[name] !== undefined, `the bundle has no ${name}`);
  const a = answer([row(1, key(0x11), { netMsat: '-2500' })]);
  assert.deepEqual(bundle.seasonView(a, { title: 'T' }), seasonView(a, { title: 'T' }));
});
