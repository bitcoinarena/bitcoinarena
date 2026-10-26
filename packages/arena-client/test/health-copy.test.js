// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE'S KEPT COPY (kanban #686, 2026-10-26: "health is very very slow to load. Cache all the data in the background and if
// data is outdated show it instead that its older than 5 minutes. right now it's unusable."): the page's read (src/arena-ui/health/network.js)
// recorded and replayed draws the same cards; the copy keeps only what the cards use; the explorer's minute (src/website/explorer/health.js)
// asks every door the page asks, the oldest first within its budget, and serves the copy at /api/health for any page to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHealth, recorder, replay, keepable, ageOf, keyOf, live, roundPosting } from '../../../src/arena-ui/health/network.js';
import { readHealth, HEALTH_DAILY, HEALTH_CRON } from '../../../src/website/explorer/health.js';
import explorer from '../../../src/website/explorer/worker.js';

const K = (i) => String(i).padStart(2, '0').repeat(32);
// two seats, two nodes; seat 2 holds the newer census (best() keeps it), node 2 does not answer
const DAILY = { testnet: { node: ['https://s1.example/a', 'https://s2.example/b'] } };
const NODES = [{ node: K(1), endpoint: 'wss://n1.example', roles: ['signer'] }, { node: K(2), endpoint: 'https://n2.example', roles: [] }];
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 100, nodes: NODES.slice(0, 1) },
  'https://s2.example/b/roles': { censusHeight: 120, nodes: NODES },
  'https://s1.example/a/fees': { tip: 157000, inForce: { roundNodeBps: 100 } },
  'https://s2.example/b/fees': { tip: 157001, inForce: { roundNodeBps: 100 } },
  'https://s1.example/a/federations': { federations: [{ federation: K(9), height: 5, status: 'OPEN', signers: [K(1)] }] },
  'https://n1.example/owner/version': { version: '2026.1.9', protocols: [16], machine: { id: 'm1' } },
  'https://n1.example/dashboard.json': { node: K(1), totals: { total: { gameVerifyMsat: '5000' } }, byGame: [], hosts: { lnd: { synced: true, activeChannels: 2 } },
    settlements: [{ madeMs: 1000 }, { madeMs: 3000 }, { madeMs: 2000 }], rounds: Array(50).fill({ big: 'x'.repeat(100) }), days: [1, 2, 3], devClients: [{ a: 1 }] },
};
function network(seen = []) {
  return async (url) => {
    const u = String(url), path = u.replace(/\?.*/, '');
    seen.push(u);
    if (/n2\.example/.test(u)) throw new TypeError('fetch failed');
    if (u === HEALTH_DAILY) return new Response(JSON.stringify(DAILY));
    const body = DOORS[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
  };
}
// the cards as data: every draw's last props per element; nodeView reduced to what it was handed
function cards() {
  const last = {};
  const H = new Proxy({}, { get: (_, k) => (k === 'draw' ? (el, kind, props) => { last[el] = JSON.stringify(props); }
    : k === 'nodeView' ? (n) => ({ node: n.node, answered: !!(n.version && n.version.ok), dash: !!(n.dash && n.dash.ok) }) : () => []) });
  return { last, health: makeHealth({ H, $: (id) => id, window: {} }) };
}

test('a recorded read and the replay of its kept copy draw the same cards; the copy keeps only what they use', async () => {
  const net = network();
  const rec = recorder((b, p) => live(b, p, net));
  const a = cards();
  assert.equal(await a.health.read({ transport: rec.transport, daily: async () => DAILY }), true);
  const copy = { daily: DAILY, answers: keepable(rec.answers, a.health.spare()) };
  const b = cards();
  assert.equal(await b.health.read({ transport: replay(copy), daily: async () => DAILY }), true);
  const els = Object.keys(a.last).filter((k) => k !== 'read');
  assert.ok(els.length >= 15, `too few cards drawn: ${els}`);
  for (const el of els) assert.equal(b.last[el], a.last[el], `card ${el} drawn differently from the copy`);
  // the census the replay used is seat 2's (the newer); seat 1's /roles is spare and not kept
  assert.match(a.last.nodes, new RegExp(K(2)));
  assert.deepEqual([copy.answers[keyOf('https://s1.example/a', '/roles')].ok, copy.answers[keyOf('https://s2.example/b', '/roles')].body.censusHeight], [false, 120]);
  // a dashboard without its rounds, days and dev clients, its newest settlement only
  const d = copy.answers['https://n1.example/dashboard.json'].body;
  assert.deepEqual(Object.keys(d).sort(), ['byGame', 'hosts', 'node', 'settlements', 'totals']);
  assert.deepEqual(d.settlements, [{ madeMs: 3000 }]);
  // GET /served is kept under its door, not its window
  assert.ok(copy.answers['https://s1.example/a/served'], 'the served window is kept as /served');
});

test('a copy is as old as its oldest answer; a door it has not read is not answered', async () => {
  assert.equal(ageOf({ answers: { a: { atMs: 5000 }, b: { atMs: 3000 }, c: { atMs: 9000 } } }), 3000);
  assert.equal(ageOf({ atMs: 7, answers: {} }), 7);
  assert.deepEqual(await replay({ answers: {} })('https://x', '/roles'), { ok: false, status: 0, why: 'not read yet', ms: 0 });
});

function kv() { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; }

test('the explorer\'s minute: every door the page asks, the copy complete; the next minute asks them again', async (t) => {
  const EXPLORER = kv(), seen = [];
  const quiet = t.mock.method(console, 'log', () => {});
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const n = await readHealth({ EXPLORER }, network(seen));
  assert.equal(n.complete, true);
  assert.equal(n.limited, false);
  const copy = JSON.parse(EXPLORER.m.get('health'));
  assert.equal(copy.complete, true);
  assert.equal(copy.atMs, now);
  assert.deepEqual(copy.daily, DAILY);
  // the node reached only through the census was asked (the second pass), and the unreachable one is kept as not answering
  assert.ok(seen.includes('https://n1.example/owner/version'));
  assert.equal(copy.answers['https://n2.example/owner/version'].ok, false);
  // its own draw is the page's: replayed, it draws node 1 as answering
  const c = cards();
  assert.equal(await c.health.read({ transport: replay(copy), daily: async () => copy.daily }), true);
  assert.match(c.last.nodes, /"answered":true/);
  // a minute later: every door asked again (and daily.json)
  seen.length = 0; now += 60000;
  const again = await readHealth({ EXPLORER }, network(seen));
  assert.equal(again.asked, again.doors + 1);
  assert.equal(seen.length, again.asked);
  assert.equal(JSON.parse(EXPLORER.m.get('health')).atMs, now);
  quiet.mock.restore();
});

test('a budget smaller than the doors: the oldest asked first, each minute a part, the copy as old as its oldest answer', async (t) => {
  t.mock.method(console, 'log', () => {});
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const EXPLORER = kv();
  const full = await readHealth({ EXPLORER: kv() }, network());
  const budget = Math.ceil(full.asked / 3) + 1;
  const runs = [];
  for (let i = 0; i < 6; i++) { const seen = []; runs.push({ ...(await readHealth({ EXPLORER, HEALTH_BUDGET: String(budget) }, network(seen))), seen: seen.length }); now += 60000; }
  for (const r of runs) assert.ok(r.seen <= budget, `asked ${r.seen} of a budget of ${budget}`);
  assert.equal(runs.at(-1).complete, true, 'every door read within a few minutes');
  // once all are read, each minute refreshes the oldest: the copy is never older than the rounds it takes to go round
  const last = JSON.parse(EXPLORER.m.get('health'));
  assert.ok(now - 60000 - last.atMs <= 4 * 60000, `copy ${(now - last.atMs) / 1000} s old`);
});

test('the subrequest limit reached: nothing more asked that run, and no door loses the answer it had', async (t) => {
  t.mock.method(console, 'log', () => {});
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const EXPLORER = kv();
  await readHealth({ EXPLORER }, network());
  const before = JSON.parse(EXPLORER.m.get('health'));
  now += 60000;
  let n = 0; const net = network();
  const limited = async (u, o) => { if (++n > 5) throw new Error('Too many subrequests.'); return net(u, o); };
  const r = await readHealth({ EXPLORER }, limited);
  assert.equal(r.limited, true);
  const after = JSON.parse(EXPLORER.m.get('health'));
  assert.equal(after.answers['https://n1.example/owner/version'].ok, true);
  assert.deepEqual(after.answers['https://n1.example/owner/version'].body, before.answers['https://n1.example/owner/version'].body);
  assert.equal(after.atMs, before.atMs, 'the copy says it is as old as the answers it could not renew');
});

test('GET /api/health: the kept copy, readable from any page (CORS); none yet is a 404 that says so; its own cron', async () => {
  const EXPLORER = kv();
  const none = await explorer.fetch(new Request('https://explorer.bitcoin-arena.io/api/health'), { EXPLORER }, {});
  assert.equal(none.status, 404);
  assert.match((await none.json()).why, /no copy/);
  EXPLORER.m.set('health', JSON.stringify({ atMs: 5, daily: DAILY, answers: {} }));
  const r = await explorer.fetch(new Request('https://explorer.bitcoin-arena.io/api/health'), { EXPLORER }, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await r.json()).atMs, 5);
  // the copy's own trigger, beside the transactions' minute (wrangler.toml)
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../../../src/website/explorer/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, new RegExp(`crons = \\["\\* \\* \\* \\* \\*", "${HEALTH_CRON.replace(/[*/]/g, '\\$&')}"\\]`));
});

// THE ROUNDS POSTED FOR EACH APP (kanban #692): the newest version's grids for the rest of today and the next 24 h, posted (with the draw
// block's confirmations), delayed or failed, each with its why
test('the APPS table\'s rounds: posted (N), delayed, failed - only the newest version counts, and every status says why', () => {
  const H = 3600000, now = Date.UTC(2026, 9, 26, 10, 0);
  const F1 = 'f1'.repeat(32), F2 = 'f2'.repeat(32), V1 = 'a1'.repeat(32), V2 = 'a2'.repeat(32), W = 'b1'.repeat(32);
  const games = [{ name: 'rps', version: 1, id: V1 }, { name: 'rps', version: 2, id: V2 }, { name: 'updown', version: 7, id: W }];
  const grid = (txid, from, to, ct, fed, pub, beacon) => ({ game: 'x', firstWindowMs: String(from), lastCloseMs: String(to), committeeTimeMs: String(ct), federation: fed,
    publication: { txid, ...pub }, beacon: { needed: 6, ...beacon } });
  const ex = (g, gameId) => ({ gameId, publication: { txid: g.publication.txid, height: null }, committeeTimeMs: g.committeeTimeMs, federation: g.federation });
  // rps v2: posted today (8 deep), and the next day's grid published, its draw block 2 of 6; rps v1 is not the newest and does not count
  const p1 = grid('aa'.repeat(32), now - 10 * H, now + 14 * H, 1, F1, { height: 100, confirmations: 20 }, { height: 102, depth: 8 });
  const p2 = grid('ab'.repeat(32), now + 14 * H, now + 38 * H, 2, F1, { height: 110, confirmations: 10 }, { height: 115, depth: 2 });
  const old = grid('ac'.repeat(32), now - 10 * H, now + 38 * H, 3, F1, { height: 90, confirmations: 30 }, { height: 92, depth: 28 });
  // updown v7: posted, but no seat draws its committee; and nothing after 20:00
  const u1 = grid('ad'.repeat(32), now - 2 * H, now + 10 * H, 4, F2, { height: 100, confirmations: 20 }, { height: 102, depth: 18 });
  const pending = [{ grids: [p1, old, u1] }, { grids: [{ ...p1, beacon: { ...p1.beacon, depth: 7 } }, p2] }];
  const expected = [ex(p1, V2), ex(p2, V2), ex(old, V1), ex(u1, W)];
  const rounds = [{ game: { id: W }, committeeTimeMs: '4', federation: F2, committee: { drawn: false, why: 'that census carries 0 game nodes' } },
    { game: { id: V2 }, committeeTimeMs: '1', federation: F1, committee: { drawn: true } }];
  const fedNo = (f) => ({ [F1]: 1, [F2]: 2 })[f] || null;
  const got = roundPosting({ games, pending, expected, rounds, nowMs: now, fedNo });
  const rps = got.get('rps'), up = got.get('updown');
  // the rest of today: v2's posted grid, the furthest seat's reading (8, not 7)
  assert.deepEqual([rps.today.t, rps.today.c], ['posted (8)', 'ok']);
  assert.match(rps.today.tip, /^version 2; in \(\) the confirmations of the draw block/);
  assert.match(rps.today.tip, /Federation 1, rounds 10-26 00:00 to 10-27 00:00 UTC: posted: its draw block 102 has 8 confirmations/);
  assert.doesNotMatch(rps.today.tip, /block 92/, 'the old version is not counted');
  // the next 24 h: the next day's grid draws in 2 of 6
  assert.deepEqual([rps.next.t, rps.next.c], ['delayed', 'warn']);
  assert.match(rps.next.tip, /its draw block 115 has 2 of 6 confirmations: posted in about 40 min/);
  // updown: posted but undrawable, and the hours no grid covers - failed, with the seat's reason
  assert.deepEqual([up.today.t, up.today.c], ['failed', 'bad']);
  assert.match(up.today.tip, /Federation 2, .*posted, but no seat can draw its committee: that census carries 0 game nodes/);
  assert.match(up.today.tip, /10-26 20:00 to 10-27 00:00 UTC: no grid of version 7 posted for it/);
  // a round table in the mempool, and one on no chain
  const m = grid('ae'.repeat(32), now - H, now + 30 * H, 5, F1, { height: null, confirmations: 0, inMempool: true }, { height: null, depth: 0 });
  const gone = grid('af'.repeat(32), now - H, now + 30 * H, 6, F2, { height: null, confirmations: 0, inMempool: false }, { height: null, depth: 0 });
  const g2 = roundPosting({ games: [{ name: 'rps', version: 2, id: V2 }], pending: [{ grids: [m] }], expected: [ex(m, V2)], nowMs: now, fedNo }).get('rps');
  // in the mempool: unconfirmed, in yellow (2026-10-26: "it needs to show as unconfirmed and yellow")
  assert.deepEqual([g2.today.t, g2.today.c, g2.today.tip.split('\n')[1]], ['unconfirmed', 'warn', 'Federation 1, rounds 10-26 09:00 to 10-27 16:00 UTC: its round table aeaeaeaeae waits in the mempool to be mined']);
  // the owner's phone, 11:33: a dead day grid (in no block, not in the mempool) and a live one waiting in the mempool from later on - not
  // "failed": unconfirmed, with the gap before it said
  const later = grid('ab'.repeat(32), now + 2 * H, now + 30 * H, 5, F1, { height: null, confirmations: 0, inMempool: true }, { height: null, depth: 0 });
  const both = roundPosting({ games: [{ name: 'rps', version: 2, id: V2 }], pending: [{ grids: [gone, later] }], expected: [ex(gone, V2), ex(later, V2)], nowMs: now, fedNo }).get('rps');
  assert.deepEqual([both.today.t, both.today.c], ['unconfirmed · gap', 'warn']);
  // readable (2026-10-26 11:44 "Wall of text"): a summary, one row per grid, the live first, and what was done about each dead stretch
  assert.equal(both.today.summary, 'The next rounds wait to be mined. Some hours have no rounds.');
  assert.deepEqual(both.today.items.map((x) => [x.s, x.live, x.say]), [['warn', true, 'waiting to be mined'], ['bad', false, 'never mined: its transaction was replaced or dropped']]);
  assert.match(both.today.items[1].fix, /^fixed: a new grid \(Fed 1\) covers today .* - waiting to be mined$/);
  const alone = roundPosting({ games: [{ name: 'rps', version: 2, id: V2 }], pending: [{ grids: [gone] }], expected: [ex(gone, V2)], nowMs: now, fedNo }).get('rps');
  assert.equal(alone.today.items[0].fix, 'not fixed yet: no new grid covers these hours');
  const g3 = roundPosting({ games: [{ name: 'rps', version: 2, id: V2 }], pending: [{ grids: [gone] }], expected: [ex(gone, V2)], nowMs: now, fedNo }).get('rps');
  assert.match(g3.today.tip, /its round table afafafafaf is in no block and not in the mempool/);
  assert.equal(g3.today.t, 'failed');
  // no seat answered: nothing claimed
  assert.equal(roundPosting({ games, nowMs: now }).get('rps').today.t, '-');
});

test('the copy keeps a seat\'s rounds small: each round\'s app, committee time, federation, drawn or why not', () => {
  const big = { ok: true, atMs: 1, body: { node: 'x', games: [{ id: 'g' }], rounds: [
    { id: 'r1', game: { id: 'g', name: 'n', title: 't' }, committeeTimeMs: '5', federation: 'f', committee: { drawn: { game: ['k'.repeat(64)], settlement: [] } }, sig: 's'.repeat(128) },
    { id: 'r2', game: { id: 'g' }, committeeTimeMs: '6', federation: 'f', committee: { drawn: false, why: 'that census carries 0 game nodes' } }] } };
  const k = 'https://s/a/rounds?next=1';
  assert.deepEqual(keepable({ [k]: big })[k].body, { rounds: [
    { game: { id: 'g' }, committeeTimeMs: '5', federation: 'f', committee: { drawn: true, why: null } },
    { game: { id: 'g' }, committeeTimeMs: '6', federation: 'f', committee: { drawn: false, why: 'that census carries 0 game nodes' } }] });
});
