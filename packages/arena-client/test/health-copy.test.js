// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE'S KEPT COPY (kanban #686, 2026-10-26: "health is very very slow to load. Cache all the data in the background and if
// data is outdated show it instead that its older than 5 minutes. right now it's unusable."): the page's read (src/arena-ui/health/network.js)
// recorded and replayed draws the same cards; the copy keeps only what the cards use; the explorer's minute (src/website/explorer/health.js)
// asks every door the page asks, the oldest first within its budget, and serves the copy at /api/health for any page to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHealth, recorder, replay, keepable, ageOf, keyOf, live } from '../../../src/arena-ui/health/network.js';
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
