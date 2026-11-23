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

// kanban #1680 refute (a44 #49): the fix keeps /api/played's reading, but GET /api/metrics and GET /metrics still run metrics() on every
// request: json_extract(json, '$.entry.stakeMsat') over every order of the last 30 days (the very read that ran D1 out of memory in #1459),
// max-age only a header, every query string a new URL. A stranger's ?x=1, ?x=2, ... runs that scan each time.
test('#1680 refute: 20 GET /api/metrics + /metrics from a stranger are not a json_extract scan of every order each', async () => {
  const { env, scans } = store(/json_extract\(json, '\$\.entry\.stakeMsat'\)/);
  for (let i = 0; i < 10; i++) {
    const r = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/metrics?x=${i}`), env, ctx); assert.equal(r.status, 200);
    await worker.fetch(new Request(`https://explorer.bitcoinarena.io/metrics?x=${i}`), env, ctx);
  }
  console.log('  MEASURED:', JSON.stringify({ requests: 20, stakeScans: scans.length }));
  assert.ok(scans.length <= 1, `20 requests ran ${scans.length} json_extract scans of every order`);
});
