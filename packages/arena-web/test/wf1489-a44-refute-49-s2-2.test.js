// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const WORKER = new URL('../../../src/website/explorer/worker.js', import.meta.url).href;
const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store(re, opts = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const scans = [];
  const tick = () => new Promise((r) => setTimeout(r, opts.ms || 5));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; },
    all: async () => { const hit = re.test(sql); if (hit) scans.push(sql); await tick(); if (hit && opts.fail) throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM'); return { results: db.prepare(sql).all(...st.b) }; },
    first: async () => { await tick(); return db.prepare(sql).get(...st.b) ?? null; }, run: async () => { await tick(); const r = db.prepare(sql).run(...st.b); return { meta: { changes: r.changes } }; } }; return st; };
  return { db, scans, env: { ADMIN_SHA256: createHash('sha256').update('c0de').digest('hex'), DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('') } } };
}
const ctx = { waitUntil: () => {} };
const SCAN = /FROM txs WHERE kind = 'order' AND stored_ms/;

// MANY ISOLATES (a44 #49 s2): the claim row is meant to make one reading at a time across isolates, but an isolate that finds the claim
// taken still reads itself when there is no copy - on a cold start and after every mark (a mark writes the copy as ''). A stranger's
// requests spread over Cloudflare's isolates: each one runs its own whole-table scan while the first one, holding the claim, is still running.
test('#1680 refute s2: 10 isolates, no copy, claim held by one - at most 2 whole-table scans', async () => {
  const { env, scans } = store(SCAN, { ms: 20 });
  const isolates = await Promise.all(Array.from({ length: 10 }, (_, i) => import(WORKER + `?s2-2-iso${i}`).then((m) => m.default)));
  const rs = await Promise.all(isolates.map((w, i) => w.fetch(new Request(`https://explorer.bitcoinarena.io/api/played?x=${i}`), env, ctx)));
  for (const r of rs) assert.equal(r.status, 200);
  console.log('  MEASURED:', JSON.stringify({ isolates: 10, wholeTableScans: scans.length }));
  assert.ok(scans.length <= 2, `10 isolates ran ${scans.length} parallel scans though the claim was taken`);
});
