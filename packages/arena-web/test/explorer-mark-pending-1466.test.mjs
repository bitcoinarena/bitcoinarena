// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST BROWSER'S ENTRY IS MARKED THOUGH IT CLOSED BEFORE THE EXPLORER HELD IT (kanban #1466, Daniel 2026-11-11: "Sind die Runden vom 11.11 heute von 22 echten
// spielern? Prüfe das" - all 22 were playtest bots on the admin's address; "fix it in code so it won't happen again")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { applyPendingMarks } from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} } } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
const markIp = (env, ip, body) => worker.fetch(new Request('https://explorer.bitcoinarena.io/api/mark-ip', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), env, { waitUntil: () => {} });
const DAY = 86400000, T = Date.UTC(2026, 10, 11, 7, 14);

test('#1466 an admin address marks an entry before the explorer holds it; the mark lands when the entry arrives, as bot for a browser under automation', async () => {
  const { db, env } = store();
  db.prepare('INSERT INTO admin_ips (ip, at_ms) VALUES (?, ?)').run('203.0.113.7', Date.now());
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, 'rock-paper-scissors', 'fe', ?, 'ACCEPTED', 'h', ?, 0)`);
  // the page under automation tells its entry within seconds; the explorer has not read it yet
  const r = await (await markIp(env, '203.0.113.7', { keys: [hex(1)], kind: 'bot' })).json();
  assert.deepEqual(r, { ok: true, marked: 1, took: [hex(1)], kind: 'bot', by: 'address' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marked').get().n, 0);
  // the next poll reads the order: the mark lands, the pending row goes
  put.run(hex(1), hex(900), T, JSON.stringify({ entry: { player: hex(50), stakeMsat: '100000' } }));
  await applyPendingMarks(env);
  assert.deepEqual(db.prepare('SELECT key, kind, by_ip FROM marked').all().map((x) => ({ ...x })), [{ key: hex(1), kind: 'bot', by_ip: '203.0.113.7' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mark_pending').get().n, 0);
  // played: no real player that day
  const p = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/played'), env, { waitUntil: () => {} })).json();
  assert.equal(p.day[0].all.realPlayers, 0); assert.equal(p.day[0].all.bot, 1);
});

test('#1466 any other address is refused, a held mark is never overwritten, a pending mark expires after 2 days, an admin browser without automation stays owner', async () => {
  const { db, env } = store();
  db.prepare('INSERT INTO admin_ips (ip, at_ms) VALUES (?, ?)').run('203.0.113.7', Date.now());
  assert.equal((await markIp(env, '198.51.100.9', { keys: [hex(2)], kind: 'bot' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mark_pending').get().n, 0);
  db.prepare("INSERT INTO marked (key, kind, at_ms, by_ip) VALUES (?, 'owner', 1, NULL)").run(hex(3));
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, 'rock-paper-scissors', 'fe', ?, 'ACCEPTED', 'h', '{}', 0)`);
  put.run(hex(3), hex(901), T);
  await markIp(env, '203.0.113.7', { keys: [hex(3)], kind: 'bot' });
  assert.equal(db.prepare('SELECT kind FROM marked WHERE key = ?').get(hex(3)).kind, 'owner');
  const plain = await (await markIp(env, '203.0.113.7', { keys: [hex(4)] })).json();
  assert.equal(plain.kind, 'owner');
  await applyPendingMarks(env, Date.now() + 2 * DAY + 1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mark_pending').get().n, 0);
  put.run(hex(4), hex(902), T); await applyPendingMarks(env);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marked WHERE key = ?').get(hex(4)).n, 0);
});
