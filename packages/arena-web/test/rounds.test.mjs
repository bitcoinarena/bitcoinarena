// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S ROUNDS PAGE IN REACT (kanban #564): from /api/rounds as a seat serves it (the shapes of arena-node's rounds-page test) -
// the stat cards, upcoming rounds by start with their entry, stake and committee, the finished ones opened for their players (winners
// first, names never HTML), a free round's dashes, and the words for nobody played, an unreadable round and an unreadable node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoundsPage, Result, sat, fromNow, byWin, utcOf, PAGE } from '../dist/test/rounds.mjs';

const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const NOW = Date.UTC(2026, 9, 5, 15);
const ROUNDS = {
  node: 'ab'.repeat(32), nowMs: String(NOW),
  upcoming: [
    { id: hex(3), startTime: '2026-10-05T16:03:00.000Z', endTime: '2026-10-05T16:04:22.000Z', free: false, stakeMsat: '100000', entryOpen: false, phase: 'pending', committee: { drawn: false, why: 'the beacon is not yet' } },
    { id: hex(1), startTime: '2026-10-05T16:00:00.000Z', endTime: '2026-10-05T16:01:22.000Z', free: true, stakeMsat: '0', entryOpen: true, phase: 'open', game: { name: 'rock-paper-scissors', title: 'Rock Paper Scissors', icon: '/icon.svg' }, committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
    { id: hex(2), startTime: '2026-10-05T16:01:30.000Z', endTime: '2026-10-05T16:02:52.000Z', free: false, stakeMsat: '12345000', entryOpen: false, phase: 'closed', committee: null },
  ],
  finished: [
    { id: hex(5), startTime: '2026-10-05T14:00:00.000Z', endTime: '2026-10-05T14:01:22.000Z', free: false, stakeMsat: '100000', joined: 4, committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
    { id: hex(6), startTime: '2026-10-05T13:00:00.000Z', endTime: '2026-10-05T13:01:22.000Z', free: true, stakeMsat: '0', joined: 1, committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
  ],
};
const player = (n, more) => ({ entry: hex(0x40 + n), player: hex(0x50 + n), name: `p${n}`, stakeMsat: '100000', outcome: 'FAILED', score: 0, signedBy: 2, wonMsat: '0', winningsState: 'NONE', ...more });
const PAID = { id: hex(5), free: false, players: [
  player(1, { score: 900 }), player(2, { outcome: 'DELIVERED', score: 400, wonMsat: '12345678', winningsState: 'PAID' }),
  player(3, { outcome: 'DELIVERED', score: 700, wonMsat: '12345678', winningsState: 'PAID' }), player(4, { outcome: null, score: null, signedBy: 0, name: '<img src=x>' }) ] };

test('the words: sat, how far from now, the UTC instant, the winners first', () => {
  assert.deepEqual([sat('12345000'), sat('0'), sat(undefined)], ['12,345 sat', '0 sat', '0 sat']);
  assert.deepEqual([fromNow(NOW + 3 * 60000, NOW), fromNow(NOW - 2 * 3600000, NOW), fromNow(NOW + 20000, NOW)], ['in 3 min', '2 h ago', 'in 20 s']);
  assert.equal(utcOf('2026-10-05T16:00:00.000Z'), '2026-10-05 16:00:00 UTC');
  assert.deepEqual(byWin(PAID.players).map((p) => p.name), ['p3', 'p2', 'p1', '<img src=x>']);
});

test('the page: stat cards, upcoming by start with entry, stake and committee, finished closed', () => {
  const h = renderToStaticMarkup(React.createElement(RoundsPage, { data: ROUNDS, readResult: async () => PAID }));
  assert.match(h, /<span>Upcoming<\/span><b>3<\/b><small>next in 1 h<\/small>/);
  assert.match(h, /<span>Entry open<\/span><b class="ok">1<\/b><small>join now<\/small>/);
  assert.match(h, /<span>Finished<\/span><b>2<\/b><small>5 entries<\/small>/);
  const order = [...h.split('<h2>Finished')[0].matchAll(/<code title="([0-9a-f]{64})">/g)].map((m) => m[1]);
  assert.deepEqual(order, [hex(1), hex(2), hex(3)], 'sorted by start, not as listed');
  assert.match(h, /<img src="\/icon.svg" alt=""\/><b>Rock Paper Scissors<\/b>/);
  assert.match(h, /<span class="pill on">Entry open<\/span><span class="pill">free<\/span>/);
  assert.match(h, /<span class="pill">Entry closed<\/span><span class="pill">stake 12,345 sat<\/span>/);
  assert.match(h, /<span class="pill wait">Pending<\/span><span class="pill">stake 100 sat<\/span>/);
  assert.match(h, /Committee not drawn<\/span><span class="dim"> - the beacon is not yet<\/span>/);
  assert.match(h, /<details class="committee"><summary>Committee: <b>1<\/b> game \/ verify · <b>1<\/b> settlement<\/summary>/, 'the counts in one line, the keys folded');
  assert.match(h, /in 1 h · 2026-10-05 16:00:00 UTC/);
  assert.match(h, /aria-expanded="false"/); assert.match(h, /<span class="pill">4 joined<\/span>/);
  assert.doesNotMatch(h, /<table/, 'finished rounds closed');
});

test('a finished round opened: its players read once, winners first, sats, names as text; closed again', async () => {
  const asked = [];
  const p = new RoundsPage({ data: ROUNDS, readResult: async (id) => { asked.push(id); return PAID; } });
  p.setState = (u) => Object.assign(p.state, typeof u === 'function' ? u(p.state) : u);
  await p.toggle(hex(5));
  const h = renderToStaticMarkup(p.render());
  assert.deepEqual(asked, [hex(5)]);
  const rows = [...h.matchAll(/<tr><td>(.*?)<\/tr>/g)].map((m) => m[1]);
  assert.deepEqual(rows.map((r) => (/^<b>(.*?) <\/b>/.exec(r) || [])[1]), ['p3', 'p2', 'p1', '&lt;img src=x&gt;']);
  assert.match(rows[0], /<td class="n won">12,345 sat<\/td><td class="dim">PAID<\/td>/);
  assert.match(rows[2], /<td class="n">0 sat<\/td>/);
  assert.match(rows[3], /no result<\/td><td class="n">-<\/td>/);
  assert.match(rows[0], /DELIVERED<span class="dim"> \(2 signed\)<\/span>/);
  assert.doesNotMatch(h, /<img src=x/);
  assert.match(h, /aria-expanded="true"/);
  await p.toggle(hex(5)); await p.toggle(hex(5));
  assert.deepEqual(asked, [hex(5)], 'read once, kept');
});

test('a free round\'s dashes; nobody played; a round that cannot be read; the node that cannot be read; nothing listed', () => {
  const free = renderToStaticMarkup(React.createElement(Result, { res: { free: true, players: [player(1, { outcome: 'DELIVERED', score: 300, winningsState: 'FREE' })] } }));
  assert.match(free, /<td class="n">-<\/td><td class="dim">free round<\/td>/);
  assert.match(renderToStaticMarkup(React.createElement(Result, { res: { free: false, players: [] } })), /nobody played this round/);
  assert.match(renderToStaticMarkup(React.createElement(Result, { res: { error: '404 this node holds no such round' } })), /could not read this round: 404 this node holds no such round/);
  assert.match(renderToStaticMarkup(React.createElement(RoundsPage, { data: { error: '500' } })), /could not read this node&#x27;s rounds: 500/);
  const started = renderToStaticMarkup(React.createElement(RoundsPage, { data: { ...ROUNDS, nowMs: String(Date.parse('2026-10-05T16:02:00Z')) } }));
  assert.match(started, /<small>first started 2 min ago<\/small>/, 'a listed round that began is not "next"');
  const none = renderToStaticMarkup(React.createElement(RoundsPage, { data: { ...ROUNDS, upcoming: [], finished: [] } }));
  assert.match(none, /no round announced<\/small>/); assert.match(none, /<p class="empty">no round finished yet<\/p>/);
});

test('a seat that lists thousands: 50 per list, then 50 more at a time', () => {
  const many = { ...ROUNDS, upcoming: Array.from({ length: 120 }, (_, i) => ({ ...ROUNDS.upcoming[1], id: (i + 1).toString(16).padStart(64, '0'), startTime: new Date(NOW + (i + 1) * 60000).toISOString() })), finished: [] };
  const p = new RoundsPage({ data: many });
  p.setState = (u) => Object.assign(p.state, typeof u === 'function' ? u(p.state) : u);
  const cards = () => (renderToStaticMarkup(p.render()).match(/class="card round"/g) || []).length;
  assert.equal(PAGE, 50); assert.equal(cards(), 50);
  assert.match(renderToStaticMarkup(p.render()), />Show 50 more<\/button> <span class="dim">50 of 120 shown<\/span>/);
  p.setState((s) => ({ shownUp: s.shownUp + PAGE })); assert.equal(cards(), 100);
  assert.match(renderToStaticMarkup(p.render()), />Show 20 more<\/button>/);
  p.setState((s) => ({ shownUp: s.shownUp + PAGE })); assert.equal(cards(), 120);
  assert.doesNotMatch(renderToStaticMarkup(p.render()), /Show \d+ more/);
});
