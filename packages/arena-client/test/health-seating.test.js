// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS TABLE KNOWS WHEN NO ROUND CAN BE JOINED (kanban #758, 2026-10-28, a tester: "The health page must be able to understand these
// kind of outages and show it in the 'App' section"). The outage of #757 (measured 10:05Z): every seat listed the day's rounds, entry open,
// and no round was seated - committee.seated false for both roles, 0-4 of the 9 drawn answering - while the table said "posted" in green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHealth, recorder, replay, keepable, live, roundSeating, NOW_ROUNDS } from '../../../src/arena-ui/health/network.js';

const NOW = 1_793_181_590_065;   // 2026-10-28 09:59:50Z, the outage's listing
const K = (i) => String(i).padStart(2, '0').repeat(32);
const RPS = 'aa'.repeat(32), NB = 'bb'.repeat(32), UD = 'cc'.repeat(32);
const GAMES = [{ id: RPS, name: 'rock-paper-scissors', title: 'Rock Paper Scissors', version: 3 }, { id: NB, name: 'nextblock', title: 'Next Block', version: 2 },
  { id: UD, name: 'btc-updown-15m', title: 'Up or Down', version: 7 }];
const DRAWN = Array.from({ length: 9 }, (_, i) => K(i + 10));
// a round as GET /rounds?next=8 lists it: seated or not, its entry open or not, starting `inMin` minutes from NOW
let n = 0;
const round = (game, { seated = false, open = true, inMin = 5, played = true } = {}) => {
  const start = NOW + inMin * 60000;
  return { id: (++n).toString(16).padStart(8, '0').padEnd(64, 'f'), phase: 'open', entryOpen: open, played, game: { id: game, name: GAMES.find((g) => g.id === game).name },
    startTimeMs: String(start), entryCloseMs: String(start + 80000), signerNodes: 7, needed: 5,
    committee: { drawn: { game: DRAWN, settlement: DRAWN }, game: DRAWN.slice(0, 7), settlement: DRAWN.slice(0, 7), seated: { game: seated, settlement: seated },
      drawnCount: { game: 9, settlement: 9 }, eligibleKeys: 45 } };
};
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i));

// TODAY'S NUMBERS: 120 RPS, 36 Next Block, 4 Up/Down open (and 12 more Up/Down in the hour, entry not open yet), none seated
const OUTAGE = { nowMs: String(NOW), rounds: [...times(120, (i) => round(RPS, { inMin: i % 60 })), ...times(36, (i) => round(NB, { inMin: i % 60 })), ...times(4, () => round(UD)),
  ...times(12, () => round(UD, { open: false, inMin: 30 })), ...times(40, () => round(RPS, { inMin: 100 }))] };
const ANSWERING = [DRAWN[0], DRAWN[3], K(80)];   // 2 of the 9 drawn answer this page

test('the outage of #757: rounds listed, none seated - red "no joinable rounds", with how many of the 9 drawn answer', () => {
  const got = roundSeating({ games: GAMES, lists: [OUTAGE, OUTAGE], nowMs: NOW, answering: ANSWERING });
  for (const [name, k] of [['rock-paper-scissors', 120], ['nextblock', 36], ['btc-updown-15m', 16]]) {
    const c = got.get(name);
    assert.equal(c.c, 'bad', name);
    assert.equal(c.t, 'no joinable rounds - posted but not seated (2 of 9 drawn answer)', name);
    assert.match(c.tip, new RegExp(`^No round can be joined[^\\n]*\\n${k} round\\(s\\) open or starting by 10:59 UTC, from 2 seat\\(s\\)`), name);
    assert.match(c.tip, new RegExp(`listed but not seated: ${k} \\(2 of 9 drawn answer\\)\\njoinable now \\(seated, entry open\\): 0$`), name);
  }
  // the rounds after the hour (RPS at +100 min) are not counted; with no node answering, "0 of 9"
  assert.match(roundSeating({ games: GAMES, lists: [OUTAGE], nowMs: NOW, answering: [] }).get('nextblock').t, /\(0 of 9 drawn answer\)$/);
});

test('healthy: the next rounds seated - green, joinable counted; some not seated - amber; seated, none open - amber', () => {
  const healthy = { rounds: [...times(10, (i) => round(RPS, { seated: true, inMin: i * 5 })), ...times(4, (i) => round(NB, { seated: true, inMin: i * 15, open: i < 2 }))] };
  const got = roundSeating({ games: GAMES, lists: [healthy], nowMs: NOW, answering: DRAWN });
  assert.deepEqual([got.get('rock-paper-scissors').c, got.get('rock-paper-scissors').t], ['ok', '10 joinable · 10 of 10 seated']);
  assert.deepEqual([got.get('nextblock').c, got.get('nextblock').t], ['ok', '2 joinable · 4 of 4 seated']);
  // a game with no round in the hour, and nothing posted today: nothing to say
  assert.deepEqual([got.get('btc-updown-15m').c, got.get('btc-updown-15m').t], ['muted', '-']);
  // one seat says seated and another not: seated (the lobby takes the seat that names the certificate)
  const r = round(RPS, { seated: true }), notYet = { ...r, committee: { ...r.committee, seated: { game: false, settlement: false } } };
  assert.equal(roundSeating({ games: GAMES, lists: [{ rounds: [notYet] }, { rounds: [r] }], nowMs: NOW }).get('rock-paper-scissors').c, 'ok');
  // some seated, some not
  const mixed = roundSeating({ games: GAMES, lists: [{ rounds: [round(RPS, { seated: true }), round(RPS), round(RPS)] }], nowMs: NOW, answering: DRAWN.slice(0, 4) }).get('rock-paper-scissors');
  assert.deepEqual([mixed.c, mixed.t], ['warn', '1 joinable · 2 of 3 not seated (4 of 9 drawn answer)']);
  // seated, entry not open yet
  const later = roundSeating({ games: GAMES, lists: [{ rounds: [round(UD, { seated: true, open: false })] }], nowMs: NOW }).get('btc-updown-15m');
  assert.deepEqual([later.c, later.t], ['warn', '1 seated · none open yet']);
  // only the game role seated is not seated
  const half = round(NB); half.committee.seated = { game: true, settlement: false };
  assert.equal(roundSeating({ games: GAMES, lists: [{ rounds: [half] }], nowMs: NOW }).get('nextblock').c, 'bad');
  // a round its seat does not play in its window (played: false) does not count
  assert.equal(roundSeating({ games: GAMES, lists: [{ rounds: [round(NB, { played: false })] }], nowMs: NOW }).get('nextblock').t, '-');
});

test('posted today but no seat lists a round in the hour: red; no seat answered at all: not known, amber', () => {
  const posted = (name) => name !== 'btc-updown-15m';
  const got = roundSeating({ games: GAMES, lists: [{ rounds: [round(RPS, { seated: true })] }], nowMs: NOW, posted });
  assert.deepEqual([got.get('nextblock').c, got.get('nextblock').t], ['bad', 'no joinable rounds - posted but none listed']);
  assert.equal(got.get('btc-updown-15m').c, 'muted');
  const none = roundSeating({ games: GAMES, lists: [null, null], nowMs: NOW, posted });
  assert.deepEqual([none.get('rock-paper-scissors').c, none.get('rock-paper-scissors').t], ['warn', 'no seat answered']);
});

test('the kept copy of a seat\'s listing is small and says the same', () => {
  const k = 'https://s1.example/a' + NOW_ROUNDS;
  const kept = keepable({ [k]: { ok: true, body: OUTAGE, atMs: NOW } })[k].body;
  assert.ok(JSON.stringify(kept).length < JSON.stringify(OUTAGE).length / 4, 'kept small');
  assert.equal(kept.rounds.length, 172, 'only the hour\'s rounds kept');
  const a = roundSeating({ games: GAMES, lists: [OUTAGE], nowMs: NOW, answering: ANSWERING }), b = roundSeating({ games: GAMES, lists: [kept], nowMs: NOW, answering: ANSWERING });
  assert.deepEqual([...b], [...a]);
});

// the whole read: the Apps table carries the column, red in the outage, and the replay of its kept copy draws the same
const DAILY = { testnet: { node: ['https://s1.example/a', 'https://s2.example/b'] } };
const NODES = [{ node: DRAWN[0], endpoint: 'https://n1.example', roles: ['signer'] }, { node: DRAWN[1], endpoint: 'https://n2.example', roles: ['signer'] }];
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 120, nodes: NODES },
  'https://s1.example/a/fees': { tip: 157000, inForce: { roundNodeBps: 100 } },
  'https://s1.example/a/network-games': { games: GAMES.map((g) => ({ ...g, seats: [1, 2] })) },
  'https://s1.example/a/rounds': OUTAGE, 'https://s2.example/b/rounds': OUTAGE,
  'https://n1.example/owner/version': { version: '2026.1.9', protocols: [16] },
};
const network = async (url) => {
  const u = String(url), path = u.replace(/\?.*/, '');
  if (/n2\.example/.test(u)) throw new TypeError('fetch failed');
  if (/\/rounds\?next=1$/.test(u)) return new Response(JSON.stringify({ why: 'not this one' }), { status: 404 });
  const body = DOORS[path];
  return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
};
function cards() {
  const last = {};
  const H = new Proxy({}, { get: (_, k) => (k === 'draw' ? (el, kind, props) => { last[el] = props; }
    : k === 'appsView' ? (games) => games.map((g) => ({ name: g.name, title: g.title, type: '-', newest: g.version, total: 0, month: 0 })) : () => []) });
  return { last, health: makeHealth({ H, $: (id) => id, window: {} }) };
}

test('the Apps table: a "Next hour" column, red in the outage (1 of 9 drawn answer), the row\'s dot red; its kept copy draws the same', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const rec = recorder((b, p) => live(b, p, network));
  const a = cards();
  assert.equal(await a.health.read({ transport: rec.transport, daily: async () => DAILY }), true);
  const apps = a.last.apps;
  const col = apps.head.indexOf('Next hour: seated / joinable');
  assert.ok(col > 0 && apps.head.indexOf('Rounds today') === col + 1 && apps.head.includes('Tomorrow'), apps.head.join(' | '));
  assert.equal(apps.rows.length, 3);
  for (const r of apps.rows) {
    assert.equal(r.dot, 'bad', r.key);
    assert.deepEqual([r.cells[col].c, r.cells[col].t], ['bad', 'no joinable rounds - posted but not seated (1 of 9 drawn answer)'], r.key);
  }
  const b = cards();
  assert.equal(await b.health.read({ transport: replay({ answers: keepable(rec.answers, a.health.spare()) }), daily: async () => DAILY, atMs: NOW }), true);
  assert.deepEqual(b.last.apps, apps);
});
