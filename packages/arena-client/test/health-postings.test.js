// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY POSTING OF THE DAY IN THE APPS TABLE, NOT ONLY THE DUTY'S (kanban #758, 2026-10-28, the owner: "Is health showing the newly posted
// rounds? It needs to support that as well."): on 10-28 (#757) emergency grids were published by an ops tool, not by the daily duty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPostings, makeHealth, recorder, replay, keepable, live } from '../../../src/arena-ui/health/network.js';

const NOW = Date.UTC(2026, 9, 28, 10, 30);
const DAY = Date.UTC(2026, 9, 28), H = 3600000, M = 60000;
const T = (c) => c.repeat(64);
const GAMES = [{ id: 'aa'.repeat(32), name: 'rock-paper-scissors', title: 'Rock Paper Scissors', version: 5 }, { id: 'bb'.repeat(32), name: 'nextblock', title: 'Next Block', version: 6 }];
const grid = (game, txid, { first = DAY + M, last = DAY + 24 * H + M, slots = 10800, height = 157731, inMempool = false, beacon = 157758, depth = 74, committee = DAY - 12 * H } = {}) => ({
  game, firstWindowMs: String(first), lastCloseMs: String(last), slots, committeeTimeMs: String(committee), federation: T('3'),
  publication: { txid, height, confirmations: height ? 100 : 0, inMempool }, beacon: { height: beacon, depth, needed: 6 } });
const ORDER = [{ rank: 1, key: T('4'), endpoint: 'https://x.example/guardian-1' }, { rank: 2, key: T('5'), endpoint: 'https://x.example/fed2-2' }];
const posting = (txid, { height = 157731, emergency = false, role = 'primary', poster = T('4') } = {}) => ({ txid, height, emergency, role, poster, posterEndpoint: null });

// 10-28 as the seats read it at 10:30Z: the duty's primary and backup on the seats; an emergency grid with the duty's marker in the mempool;
// the ops tool's grid (no duty marker) mined, its committee block 2 of 6 deep; an earlier grid that never reached a chain; tomorrow's duty grid
const DUTY = { days: [
  { period: 'today', covers: '2026-10-28', order: ORDER, apps: [
    { name: 'rock-paper-scissors', role: 'primary', postings: [posting(T('a1')), posting(T('e1'), { height: null, emergency: true, poster: null })] },
    { name: 'rock-paper-scissors', role: 'backup', postings: [posting(T('b1'), { role: 'backup', poster: T('5') })] }] },
  { period: 'next', covers: '2026-10-29', order: ORDER, apps: [{ name: 'rock-paper-scissors', role: 'primary', postings: [posting(T('c1'), { height: 157801 })] }] }] };
const PENDING = [{ grids: [grid('rock-paper-scissors', T('a1')), grid('rock-paper-scissors', T('b1')),
  grid('rock-paper-scissors', T('f1'), { first: DAY + 13 * H + 25 * M, slots: 6400, height: 157825, beacon: 157828, depth: 2, committee: NOW - 2 * H }),
  grid('rock-paper-scissors', T('d1'), { first: DAY + 20 * M, slots: 10654, height: null, beacon: null, depth: 0 })] },
{ grids: [grid('rock-paper-scissors', T('c1'), { first: DAY + 24 * H + M, last: DAY + 48 * H + M, height: 157801, beacon: null, depth: 0, committee: DAY + 12 * H })] }];
// a grid announced to a seat (GET /expected) that no seat reads on its chain yet
const EXPECTED = [{ game: 'nextblock', gameId: 'bb'.repeat(32), firstWindowMs: String(DAY + 14 * H), lastCloseMs: String(DAY + 24 * H), slots: 600, committeeTimeMs: String(NOW), federation: T('3'),
  publication: { txid: T('91'), height: null } }];

test('every posting of today, the duty\'s and the extra ones, each with its state; the extra one says when it reaches the seats', () => {
  const got = allPostings({ games: GAMES, pending: PENDING, expected: EXPECTED, duty: DUTY, nowMs: NOW });
  const rps = got.get('rock-paper-scissors').today;
  assert.equal(rps.c, 'warn');
  // f1: committee block 2 of 6 deep -> 4 blocks, ~40 min from 10:30
  assert.equal(rps.t, '5 postings · 2 on the seats · extra posting reaches the seats ~11:10 · extra posting waiting to be mined');
  const lines = rps.tip.split('\n');
  assert.deepEqual(lines.map((l) => l.split(':')[0]).sort(), ['duty backup bbbbbbbbbb by fed2-2', 'duty primary aaaaaaaaaa by guardian-1', 'emergency grid (duty marker) eeeeeeeeee by a key outside the census',
    'extra posting dddddddddd by creator not named by the seats', 'extra posting ffffffffff by creator not named by the seats'].map((x) => x.replace(/aaaaaaaaaa/, 'a1a1a1a1a1').replace(/bbbbbbbbbb/, 'b1b1b1b1b1')
    .replace(/eeeeeeeeee/, 'e1e1e1e1e1').replace(/dddddddddd/, 'd1d1d1d1d1').replace(/ffffffffff/, 'f1f1f1f1f1')).sort());
  assert.match(rps.tip, /extra posting f1f1f1f1f1 by creator not named by the seats: 6,400 rounds from 10-28 13:25 UTC; posted, reaches the seats at ~11:10 UTC/);
  assert.match(rps.tip, /extra posting d1d1d1d1d1 [^\n]*not on chain/);
  assert.match(rps.tip, /emergency grid \(duty marker\) e1e1e1e1e1 [^\n]*waiting to be mined/);
  // the panel: the live postings first, the one not on chain last
  assert.deepEqual(rps.items.map((x) => x.s), ['ok', 'ok', 'warn', 'warn', 'bad']);
  assert.equal(rps.items[4].live, false);
  // tomorrow's duty grid, mined, its committee block not there: 12:00 + the median time's hour + 6 blocks
  assert.deepEqual([got.get('rock-paper-scissors').next.c, got.get('rock-paper-scissors').next.t], ['warn', '1 posting · 0 on the seats · next reaches the seats ~14:00']);
  // a grid announced and read by no seat: an extra posting, said so
  const nb = got.get('nextblock').today;
  assert.equal(nb.t, '1 posting · 0 on the seats · extra posting announced to the seats, not read on their chain yet');
  assert.equal(nb.c, 'warn');
});

test('only the duty\'s postings, all on the seats: green; nothing read: a dash', () => {
  const got = allPostings({ games: GAMES, pending: [{ grids: [grid('rock-paper-scissors', T('a1')), grid('rock-paper-scissors', T('b1'))] }], duty: { days: [DUTY.days[0]] }, nowMs: NOW });
  // e1 (the emergency grid in the mempool) is in that duty day; without it:
  const plain = { days: [{ ...DUTY.days[0], apps: DUTY.days[0].apps.map((a) => ({ ...a, postings: a.postings.filter((p) => !p.emergency) })) }] };
  const ok = allPostings({ games: GAMES, pending: [{ grids: [grid('rock-paper-scissors', T('a1')), grid('rock-paper-scissors', T('b1'))] }], duty: plain, nowMs: NOW }).get('rock-paper-scissors').today;
  assert.deepEqual([ok.c, ok.t], ['ok', '2 postings · 2 on the seats']);
  assert.equal(got.get('rock-paper-scissors').today.c, 'warn');
  assert.deepEqual([allPostings({ games: GAMES, nowMs: NOW }).get('nextblock').today.t, allPostings({ games: GAMES, nowMs: NOW }).get('nextblock').today.c], ['-', 'muted']);
  // only a dead posting: red
  const dead = allPostings({ games: GAMES, pending: [{ grids: [grid('nextblock', T('d1'), { height: null, beacon: null, depth: 0 })] }], nowMs: NOW }).get('nextblock').today;
  assert.equal(dead.c, 'bad');
});

// the read: the Apps table carries "Postings today", from GET /duty, /pending and /expected; the kept copy draws the same
const DAILY = { testnet: { node: ['https://s1.example/a'] } };
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 120, nodes: [] },
  'https://s1.example/a/fees': { tip: 157830, inForce: { roundNodeBps: 100 } },
  'https://s1.example/a/network-games': { games: GAMES },
  'https://s1.example/a/pending': { ok: true, grids: PENDING.flatMap((p) => p.grids), txs: [], pegIns: [], adverts: [] },
  'https://s1.example/a/expected': { expected: EXPECTED },
  'https://s1.example/a/duty': { ok: true, ...DUTY },
};
const network = async (url) => { const body = DOORS[String(url).replace(/\?.*/, '')];
  return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 }); };
function cards() {
  const last = {};
  const Hv = new Proxy({}, { get: (_, k) => (k === 'draw' ? (el, kind, props) => { last[el] = props; }
    : k === 'appsView' ? (games) => games.map((g) => ({ name: g.name, title: g.title, type: '-', newest: g.version, total: 0, month: 0 })) : () => []) });
  return { last, health: makeHealth({ H: Hv, $: (id) => id, window: {} }) };
}
test('the Apps table: a "Postings today" column with the extra postings; its kept copy draws the same', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const rec = recorder((b, p) => live(b, p, network));
  const a = cards();
  assert.equal(await a.health.read({ transport: rec.transport, daily: async () => DAILY }), true);
  const apps = a.last.apps, col = apps.head.indexOf('Postings today');
  assert.ok(col > 0 && apps.head.includes('Rounds today') && apps.head.includes('Tomorrow'), apps.head.join(' | '));
  const row = apps.rows.find((r) => r.key === 'rock-paper-scissors');
  assert.equal(row.cells[col].t, '5 postings · 2 on the seats · extra posting reaches the seats ~11:10 · extra posting waiting to be mined');
  const b = cards();
  assert.equal(await b.health.read({ transport: replay({ answers: keepable(rec.answers, a.health.spare()) }), daily: async () => DAILY, atMs: NOW }), true);
  assert.deepEqual(b.last.apps, apps);
});
