// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYED ROUNDS (kanban #1090, the owner 2026-11-03: "Played rounds mit Tages / Wochen / Monats Anzeige", "tu da meine Runden RAUS NEHMEN"):
// /api/played counts the explorer's paid entries since 2026-11-01 by round, per day, ISO week and month, per game; an entry marked through
// /api/mark (only with the admin code) by its entry id or its player key is the owner's or a bot's, every other one a real player's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker from '../../../src/website/explorer/worker.js';
import { entryIdsOf } from '../../../src/website/explorer/mark-entries.mjs';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} } } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
const call = (env, path, init) => worker.fetch(new Request('https://explorer.bitcoinarena.io' + path, init), env, { waitUntil: () => {} });
const DAY = 86400000, NOV1 = Date.UTC(2026, 10, 1), NOV2 = NOV1 + DAY, NOV3 = NOV1 + 2 * DAY;

test('played rounds per day, week and month; the owner\'s and the bots\' entries left out of the real players\' counts', async () => {
  const { db, env } = store();
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, ?, 'fe', ?, ?, 'h', ?, 0)`);
  const order = (id, round, app, ms, player, settled = 'ACCEPTED') => put.run(hex(id), hex(round), app, ms, settled, JSON.stringify({ entry: { player: hex(player), stakeMsat: '100000' } }));
  order(1, 900, 'nextblock', NOV1 - 1000, 50);                  // before 11-01: not counted
  order(2, 901, 'rock-paper-scissors', NOV1 + 1000, 51);        // a real player against the test bot
  order(3, 901, 'rock-paper-scissors', NOV1 + 2000, 52);        //   the test bot (marked by its entry id)
  order(4, 902, 'rock-paper-scissors', NOV2 + 1000, 53);        // the owner against the test bot: no real player
  order(5, 902, 'rock-paper-scissors', NOV2 + 2000, 54);
  order(6, 903, 'btc-updown-15m', NOV2 + 3000, 55);             // a market bot alone
  order(7, 904, 'nextblock', NOV3 + 1000, 51, null);            // the same real player again, not settled yet
  // marks need the admin code
  const bad = await call(env, '/api/mark', { method: 'POST', body: JSON.stringify({ kind: 'bot', keys: [hex(3)], code: 'wrong' }) });
  assert.equal(bad.status, 403);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM marked').first()).n, 0);
  // the test's own code: the live hash is the worker's constant, which a test never needs to know the code of
  const code = 'a test admin code';
  env.ADMIN_SHA256 = createHash('sha256').update(code).digest('hex');
  for (const [kind, keys] of [['bot', [hex(3), hex(5), hex(6)]], ['owner', [hex(53)]]]) {
    const r = await call(env, '/api/mark', { method: 'POST', body: JSON.stringify({ kind, keys: [...keys, 'not hex'], code }) });
    assert.deepEqual(await r.json(), { ok: true, marked: keys.length, kind });
  }
  const p = await (await call(env, '/api/played')).json();
  assert.equal(p.from, '2026-11-01');
  assert.deepEqual(p.marked, { owner: 1, bot: 3 });
  assert.deepEqual(p.day.map((d) => d.period), ['2026-11-03', '2026-11-02', '2026-11-01']);
  const [d3, d2, d1] = p.day;
  assert.deepEqual(d1.all, { rounds: 1, real: 1, settled: 1, entries: 2, realEntries: 1, owner: 0, bot: 1, realPlayers: 1 });
  assert.deepEqual(d2.all, { rounds: 2, real: 0, settled: 2, entries: 3, realEntries: 0, owner: 1, bot: 2, realPlayers: 0 });
  assert.deepEqual(d3.all, { rounds: 1, real: 1, settled: 0, entries: 1, realEntries: 1, owner: 0, bot: 0, realPlayers: 1 });
  assert.deepEqual(Object.keys(d2.games).sort(), ['btc-updown-15m', 'rock-paper-scissors']);
  // 11-01 is a Sunday: its ISO week starts 10-26; 11-02 and 11-03 are the next week's; the month holds all, the one real player once
  assert.deepEqual(p.week.map((w) => [w.period, w.all.rounds, w.all.real, w.all.realPlayers]), [['2026-11-02', 3, 1, 1], ['2026-10-26', 1, 1, 1]]);
  assert.deepEqual(p.month.map((m) => [m.period, m.all.rounds, m.all.real, m.all.realPlayers]), [['2026-11', 4, 2, 1]]);
});

test('the bots\' files give only their entry ids: market-bot orders.json and rps-opponent keys.jsonl', () => {
  assert.deepEqual(entryIdsOf(JSON.stringify([{ round: hex(1), entry: hex(2), order: 0 }, { entry: 'short' }, { entry: hex(2) }])), [hex(2)]);
  assert.deepEqual(entryIdsOf(`{"round":"${hex(1)}","entry":"${hex(3)}","secret":"${hex(9)}"}\n{"entry":"${hex(4)}"}\nnot json\n`), [hex(3), hex(4)]);
});

test('the reserve over time, rebuilt from the payments in (kanban #1095): per federation and day the median of the seats asked (kanban #1534: no longer the longest list), held at each day\'s end', async () => {
  const { env } = store();
  const day = (d, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/reserves') && u.searchParams.get('all') === '1') {
      asked.push(u.pathname.split('/')[1]);
      // guardian-1 holds A's whole list; guardian-2 one payment short of it; fed2-1 holds B
      const a = [{ at: day(28), amountMsat: '1000' }, { at: day(28, 20), amountMsat: '500' }, { at: day(30), amountMsat: '2000' }];
      if (u.pathname.startsWith('/guardian-1')) return ok({ federations: [{ federationId: 'aa', paidIn: a }] });
      if (u.pathname.startsWith('/guardian-2')) return ok({ federations: [{ federationId: 'aa', paidIn: a.slice(0, 2) }] });
      return ok({ federations: [{ federationId: 'bb', paidIn: [{ at: day(29), amountMsat: '7000' }] }] });
    }
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  assert.deepEqual(asked.sort(), ['fed2-1', 'guardian-1', 'guardian-2']);
  const m = await (await call(env, '/api/metrics')).json();
  assert.equal(m.reserveHistory.federations, 2);
  assert.deepEqual(m.reserveHistory.days.slice(0, 4), [
    { day: '2026-10-28', inMsat: '1500', heldMsat: '1500' }, { day: '2026-10-29', inMsat: '7000', heldMsat: '8500' },
    // 10-30: only guardian-1 says 2000 came in, guardian-2 says 0 - the median (the lower of two) is 0, so one seat alone adds nothing (kanban #1534)
    { day: '2026-10-30', inMsat: '0', heldMsat: '8500' }, { day: '2026-10-31', inMsat: '0', heldMsat: '8500' }]);
  assert.equal(m.reserveHistory.days.at(-1).day, new Date().toISOString().slice(0, 10), 'every day to today');
});
