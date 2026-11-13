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

// RETRY PATH (a44 #49 s2): the whole-table scan is the one that ran D1 out of memory (#1459). While it fails, nothing is kept and the claim is
// released at once, so a stranger's every next request (?x=1, ?x=2, ...) reruns the failing scan, and the minute-old copy that is still in
// state is never served - the endpoint answers 500 instead.
test('#1680 refute s2: while the scan fails, 20 GET /api/played run at most 2 scans and the last copy is served', async () => {
  const { default: worker } = await import(WORKER + '?s2-1');
  const { db, env, scans } = store(SCAN, { fail: true });
  db.prepare("INSERT INTO state (k, v) VALUES ('played', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ at: Date.now() - 61000, v: { old: true } }));
  const st = [];
  for (let i = 0; i < 20; i++) st.push(await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/played?x=${i}`), env, ctx).then((r) => r.status, () => 'threw'));
  console.log('  MEASURED:', JSON.stringify({ requests: 20, failingScans: scans.length, statuses: [...new Set(st)] }));
  assert.ok(scans.length <= 2, `20 requests ran the failing whole-table scan ${scans.length} times`);
  assert.ok(st.every((s) => s === 200), 'the last copy is served while the reading fails');
});
