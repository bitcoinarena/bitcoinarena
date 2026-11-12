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

// kanban #1680 refute (a44 #49): GET /api/totals groups EVERY order ever held (no time bound, COUNT(DISTINCT round) per app) on each request;
// max-age=300 is only a header and every query string is a new URL - the same per-request whole-table read a stranger drives in a loop.
test('#1680 refute: 20 GET /api/totals from a stranger are not a whole-table scan each', async () => {
  const { env, scans } = store(/FROM txs WHERE kind = 'order' AND round IS NOT NULL GROUP BY app/);
  for (let i = 0; i < 20; i++) { const r = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/totals?x=${i}`), env, ctx); assert.equal(r.status, 200); }
  console.log('  MEASURED:', JSON.stringify({ requests: 20, wholeTableScans: scans.length }));
  assert.ok(scans.length <= 1, `20 requests ran ${scans.length} scans of every order`);
});
