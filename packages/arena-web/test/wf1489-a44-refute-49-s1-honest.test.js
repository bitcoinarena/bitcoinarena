// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';
const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store(re) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const scans = [];
  const tick = () => new Promise((r) => setTimeout(r, 5));   // D1 is a network round trip: each call yields
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; },
    all: async () => { if (re.test(sql)) scans.push(sql); await tick(); return { results: db.prepare(sql).all(...st.b) }; },
    first: async () => { await tick(); return db.prepare(sql).get(...st.b) ?? null; }, run: async () => { await tick(); return db.prepare(sql).run(...st.b); } }; return st; };
  return { db, scans, env: { ADMIN_SHA256: 'x', DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('') } } };
}
const ctx = { waitUntil: () => {} };

import { createHash } from 'node:crypto';
// honest path: a mark with the code changes /api/played at once (the copy is dropped), and a copy older than a minute is read again
test('#1680 honest: a mark is seen at once in /api/played; an old copy is read again', async () => {
  const { env, db, scans } = store(/FROM txs WHERE kind = 'order' AND stored_ms/);
  env.ADMIN_SHA256 = createHash('sha256').update('c0de').digest('hex');
  const id = 'a'.repeat(64), player = 'b'.repeat(64), ms = Date.UTC(2026, 10, 5);
  db.prepare("INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms, kind) VALUES (?, 'r1', 'rps', 'f', ?, 'ACCEPTED', 'h', ?, ?, 'order')").run(id, ms, JSON.stringify({ entry: { player } }), ms);
  const get = async () => (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/played'), env, ctx)).json();
  const a = await get(); assert.equal(a.month[0].all.real, 1);
  const m = await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/mark', { method: 'POST', body: JSON.stringify({ code: 'c0de', kind: 'bot', keys: [player] }) }), env, ctx);
  assert.equal(m.status, 200);
  const b = await get(); assert.equal(b.month[0].all.real, 0); assert.equal(b.month[0].all.bot, 1);
  const before = scans.length; await get(); assert.equal(scans.length, before, 'served from the copy');
  db.prepare("UPDATE state SET v = ? WHERE k = 'played'").run(JSON.stringify({ at: Date.now() - 61000, v: { stale: true } }));
  const c = await get(); assert.ok(!c.stale); assert.equal(scans.length, before + 1);
  db.prepare("UPDATE state SET v = ? WHERE k = 'played'").run(JSON.stringify({ at: Date.now() + 3600000, v: { future: true } }));
  const d = await get(); assert.ok(!d.future, 'a copy dated in the future is not served');
  console.log('  MEASURED:', JSON.stringify({ realBefore: a.month[0].all.real, realAfterMark: b.month[0].all.real, scans: scans.length }));
});
