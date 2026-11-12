// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (site/explorer): GET /api/played RESCANS EVERY ORDER FOR EVERY CALLER. played() reads every order since 2026-11-01 with
// json_extract over its whole stored json (the read #1459 found running D1 out of memory in the metrics) and every marked key, on each request; the
// answer's max-age is only a header (a Worker's own response is not cached by the edge), and a query string (?x=1, ?x=2, ...) is a new URL anyway.
// A stranger asking it in a loop runs the whole-table scan each time - D1 rows read, CPU and memory - and the explorer's own poll shares that database.
// Safe: within the answer's minute, repeated GET /api/played (any query) is served from one reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const scans = [];
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => { if (/FROM txs WHERE kind = 'order' AND stored_ms/.test(sql)) scans.push(sql); return { results: db.prepare(sql).all(...st.b) }; },
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  return { scans, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}

test('#1489-r5 repeated GET /api/played from a stranger is not a whole-table scan each time', async () => {
  const { env, scans } = store();
  for (let i = 0; i < 20; i++) {
    const r = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/played?x=${i}`), env, { waitUntil: () => {} });
    assert.equal(r.status, 200);
  }
  console.log('  MEASURED:', JSON.stringify({ requests: 20, wholeTableScans: scans.length }));
  assert.ok(scans.length <= 1, `20 requests within a minute ran ${scans.length} scans of every order`);
});
