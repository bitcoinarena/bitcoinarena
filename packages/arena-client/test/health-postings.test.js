// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY POSTING OF THE DAY IN THE APPS TABLE, NOT ONLY THE DUTY'S (kanban #758, 2026-10-28, the owner: "Is health showing the newly posted
// rounds? It needs to support that as well."): on 10-28 (#757) emergency grids were published by an ops tool, not by the daily duty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPostings, blockClock, noteTip, seatKey, makeHealth, recorder, replay, keepable, live } from '../../../src/arena-ui/health/network.js';

const NOW = Date.UTC(2026, 9, 28, 10, 30);
const DAY = Date.UTC(2026, 9, 28), H = 3600000, M = 60000;
const T = (c) => c.repeat(64);
const GAMES = [{ id: 'aa'.repeat(32), name: 'rock-paper-scissors', title: 'Rock Paper Scissors', version: 5 }, { id: 'bb'.repeat(32), name: 'nextblock', title: 'Next Block', version: 6 }];
const TIP = 157829, MTP = DAY + 10 * H;   // the seats' tip at 10:30 and its median time past (our branch stamps +20 min a block)
const grid = (game, txid, { first = DAY + M, last = DAY + 24 * H + M, slots = 10800, height = 157731, inMempool = false, beacon = 157758, depth = 74, committee = DAY - 12 * H, fed = T('3') } = {}) => ({
  game, firstWindowMs: String(first), lastCloseMs: String(last), slots, committeeTimeMs: String(committee), federation: fed,
  publication: { txid, height, confirmations: height ? 1 : 0, inMempool }, beacon: { height: beacon, depth, needed: 6, medianTimeMs: String(MTP) } });
// three tips seen: 157827 at 09:50, 157828 at 10:05, 157829 at 10:25 - 15 and 20 min a block, the median time 20 min a block
const TIPS = [{ h: 157827, mtpMs: MTP - 40 * M, atMs: NOW - 40 * M }, { h: 157828, mtpMs: MTP - 20 * M, atMs: NOW - 25 * M }, { h: 157829, mtpMs: MTP, atMs: NOW - 5 * M }];
const ORDER = [{ rank: 1, key: T('4'), endpoint: 'https://x.example/guardian-1' }, { rank: 2, key: T('5'), endpoint: 'https://x.example/fed2-2' }];
const posting = (txid, { height = 157731, emergency = false, role = 'primary', poster = T('4') } = {}) => ({ txid, height, emergency, role, poster, posterEndpoint: null });

// 10-28 as the seats read it at 10:30Z: the duty's primary and backup on the seats; an emergency grid with the duty's marker in the mempool;
// the ops tool's grid (no duty marker) mined, its committee block 2 of 6 deep; an earlier grid that never reached a chain; tomorrow's duty grid
const DUTY = { days: [
  { period: 'today', covers: '2026-10-28', order: ORDER, apps: [
    { name: 'rock-paper-scissors', role: 'primary', postings: [posting(T('a1')), posting(T('e1'), { height: null, emergency: true, poster: null })] },
    { name: 'rock-paper-scissors', role: 'backup', postings: [posting(T('b1'), { role: 'backup', poster: T('5') })] }] },
  { period: 'next', covers: '2026-10-29', order: ORDER, apps: [{ name: 'rock-paper-scissors', role: 'primary', postings: [posting(T('c1'), { height: 157801 })] }] }] };
const PENDING = [{ tip: TIP, grids: [grid('rock-paper-scissors', T('a1')), grid('rock-paper-scissors', T('b1'), { fed: T('6') }),
  grid('rock-paper-scissors', T('f1'), { first: DAY + 13 * H + 25 * M, slots: 6400, height: 157825, beacon: 157828, depth: 2, committee: NOW - 2 * H }),
  grid('rock-paper-scissors', T('d1'), { first: DAY + 20 * M, slots: 10654, height: null, beacon: null, depth: 0 })] },
{ tip: TIP - 1, grids: [grid('rock-paper-scissors', T('c1'), { first: DAY + 24 * H + M, last: DAY + 48 * H + M, height: 157801, beacon: null, depth: 0, committee: DAY + 12 * H })] }];
// a grid announced to a seat (GET /expected) that no seat reads on its chain yet
const EXPECTED = [{ game: 'nextblock', gameId: 'bb'.repeat(32), firstWindowMs: String(DAY + 14 * H), lastCloseMs: String(DAY + 24 * H), slots: 600, committeeTimeMs: String(NOW), federation: T('3'),
  publication: { txid: T('91'), height: null } }];

test('the chain\'s clock is measured from the tips seen: the wall time a block takes, a range, and the step of the median time', () => {
  const c = blockClock(TIPS);
  assert.deepEqual([c.lo / M, c.hi / M, c.step / M, c.n, c.seen.h], [15, 20, 20, 2, 157829]);
  assert.equal(blockClock(TIPS.slice(0, 1)), null);
  // a height is noted once, when first seen; an older or the same height adds nothing
  assert.equal(noteTip(TIPS, { h: 157829, mtpMs: MTP, atMs: NOW }).length, 3);
  assert.deepEqual(noteTip(TIPS, { h: 157830, mtpMs: MTP + 20 * M, atMs: NOW }).at(-1), { h: 157830, mtpMs: MTP + 20 * M, atMs: NOW });
});

test('every posting of today with where it is on the chain; listed is not seated; an extra one says when it reaches the seats', () => {
  const seating = new Map([[seatKey('rock-paper-scissors', DAY - 12 * H + 2, T('3')), true], [seatKey('rock-paper-scissors', DAY - 12 * H, T('6')), false]]);
  const got = allPostings({ games: GAMES, pending: PENDING, expected: EXPECTED, duty: DUTY, nowMs: NOW, clock: blockClock(TIPS), seating });
  const rps = got.get('rock-paper-scissors').today;
  assert.equal(rps.c, 'warn');
  // f1: beacon 157828 2 of 6 deep -> 4 blocks from 10:25 at 15-20 min
  assert.equal(rps.t, '5 postings · 2 listed by the seats · extra posting reaches the seats ~11:25-11:45 (5 conf.) · extra posting waiting to be mined');
  const line = (id) => rps.tip.split('\n').find((l) => l.includes(id.slice(0, 10)));
  assert.equal(line(T('a1')), 'duty primary a1a1a1a1a1 by guardian-1: 10,800 rounds from 10-28 00:01 UTC; listed and seated; mined in 157,731 · 99 confirmations · beacon 157,758 · 6/6 deep');
  assert.equal(line(T('b1')), 'duty backup b1b1b1b1b1 by fed2-2: 10,800 rounds from 10-28 00:01 UTC; listed by the seats (not yet seated); mined in 157,731 · 99 confirmations · beacon 157,758 · 6/6 deep');
  assert.equal(line(T('f1')), 'extra posting f1f1f1f1f1 by creator not named by the seats: 6,400 rounds from 10-28 13:25 UTC; reaches the seats ~11:25-11:45 UTC (4 more blocks); mined in 157,825 · 5 confirmations · beacon 157,828 · 2/6 deep');
  assert.equal(line(T('d1')), 'extra posting d1d1d1d1d1 by creator not named by the seats: 10,654 rounds from 10-28 00:20 UTC; not on chain: neither mined nor in any seat\'s mempool; in no block and no mempool');
  assert.equal(line(T('e1')), 'emergency grid (duty marker) e1e1e1e1e1 by a key outside the census: its rounds not read yet; waiting to be mined; in the mempool');
  assert.match(rps.tip, /block times measured: 15-20 min a block \(2 seen\); the median time moves 20 min a block$/);
  // the panel: the live postings first, the one not on chain last
  assert.deepEqual(rps.items.map((x) => x.s), ['ok', 'warn', 'warn', 'warn', 'bad']);
  assert.equal(rps.items[4].live, false);
  // tomorrow's duty grid, mined in 157,801, no beacon yet: committee 12:00, the median time at 10:00 moving 20 min a block -> beacon in 7 blocks,
  // 6 deep in 12, from 10:25 at 15-20 min: 13:25-14:25
  const next = got.get('rock-paper-scissors').next;
  assert.deepEqual([next.c, next.t], ['warn', '1 posting · 0 listed by the seats · next reaches the seats ~13:25-14:25 (29 conf.)']);
  // a grid announced and read by no seat: an extra posting, said so
  assert.deepEqual([got.get('nextblock').today.c, got.get('nextblock').today.t], ['warn', '1 posting · 0 listed by the seats · extra posting announced to the seats, not read on their chain yet']);
  // no clock yet: said so, no time made up
  const blind = allPostings({ games: GAMES, pending: PENDING, duty: DUTY, nowMs: NOW }).get('rock-paper-scissors').today;
  assert.match(blind.t, /extra posting reaches the seats after its beacon block is 6 deep \(block times not measured yet\) \(5 conf\.\)/);
  assert.match(blind.tip, /block times not measured yet/);
});

test('only the duty\'s postings, all listed: green; nothing read: a dash; only a dead posting: red', () => {
  const plain = { days: [{ ...DUTY.days[0], apps: DUTY.days[0].apps.map((a) => ({ ...a, postings: a.postings.filter((p) => !p.emergency) })) }] };
  const ok = allPostings({ games: GAMES, pending: [{ tip: TIP, grids: [grid('rock-paper-scissors', T('a1')), grid('rock-paper-scissors', T('b1'))] }], duty: plain, nowMs: NOW }).get('rock-paper-scissors').today;
  assert.deepEqual([ok.c, ok.t], ['ok', '2 postings · 2 listed by the seats']);
  const none = allPostings({ games: GAMES, nowMs: NOW }).get('nextblock').today;
  assert.deepEqual([none.t, none.c], ['-', 'muted']);
  const dead = allPostings({ games: GAMES, pending: [{ grids: [grid('nextblock', T('d1'), { height: null, beacon: null, depth: 0 })] }], nowMs: NOW }).get('nextblock').today;
  assert.equal(dead.c, 'bad');
});

// the read: the Apps table carries "Postings today", from GET /duty, /pending and /expected; the kept copy draws the same
const DAILY = { testnet: { node: ['https://s1.example/a'] } };
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 120, nodes: [] },
  'https://s1.example/a/fees': { tip: 157830, inForce: { roundNodeBps: 100 } },
  'https://s1.example/a/network-games': { games: GAMES },
  'https://s1.example/a/pending': { ok: true, tip: TIP, grids: PENDING.flatMap((p) => p.grids), txs: [], pegIns: [], adverts: [] },
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
test('the Apps table: a "Postings today" column with the extra postings; the tips seen kept; its kept copy draws the same', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const rec = recorder((b, p) => live(b, p, network));
  const a = cards();
  assert.equal(await a.health.read({ transport: rec.transport, daily: async () => DAILY, tips: TIPS.slice(0, 2) }), true);
  // 157829 noted as first seen now (10:30): 15 and 25 min a block
  assert.deepEqual(a.health.tips().at(-1), { h: TIP, mtpMs: MTP, atMs: NOW });
  const apps = a.last.apps, col = apps.head.indexOf('Postings today');
  assert.ok(col > 0 && apps.head.includes('Rounds today') && apps.head.includes('Tomorrow'), apps.head.join(' | '));
  const row = apps.rows.find((r) => r.key === 'rock-paper-scissors');
  assert.equal(row.cells[col].t, '5 postings · 2 listed by the seats · extra posting reaches the seats ~11:30-12:10 (5 conf.) · extra posting waiting to be mined');
  const b = cards();
  assert.equal(await b.health.read({ transport: replay({ answers: keepable(rec.answers, a.health.spare()) }), daily: async () => DAILY, atMs: NOW, tips: a.health.tips() }), true);
  assert.deepEqual(b.last.apps, apps);
});
