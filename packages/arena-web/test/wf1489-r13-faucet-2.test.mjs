// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 13 (site/explorer): GET /api/recent (and the explorer's home page /, which inlines the same list) RUN A WHOLE-TABLE SCAN FOR EVERY
// CALLER. recent() counts every row of txs under the default "marked hidden" filter - per row a json_extract over its whole stored json (the read #1459
// found running D1 out of memory) and a correlated sub-select over every order of its round - on each request; max-age=10 is only a header (a Worker's
// own response is not cached by the edge) and each query string (?x=1, ?x=2, ...) is a new URL anyway. #1680 kept /api/played to one reading a minute,
// #2303 and #2231 did the same for /api/totals and /api/metrics; /api/recent and / were left out.
// Safe: within a short window, repeated GET /api/recent and / with junk query strings (no filter) do not each re-count the whole table.
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
  const isScan = (sql) => /SELECT COUNT\(\*\) AS n FROM txs/.test(sql) && /json_extract/.test(sql);
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; },
    all: async () => { if (isScan(sql)) scans.push(sql); return { results: db.prepare(sql).all(...st.b) }; },
    first: async () => { if (isScan(sql)) scans.push(sql); return db.prepare(sql).get(...st.b) ?? null; },
    run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, 'nextblock', 'fe', ?, 'ACCEPTED', 'h', ?, 0)`);
  for (let i = 1; i <= 50; i++) put.run(i.toString(16).padStart(64, '0'), (1000 + (i >> 1)).toString(16).padStart(64, '0'), Date.UTC(2026, 10, 2) + i, JSON.stringify({ entry: { player: (500 + i).toString(16).padStart(64, '0'), stakeMsat: '100000' } }));
  return { scans, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    ASSETS: { fetch: async () => new Response('<html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}

test('#1489-r13 repeated GET /api/recent and / from a stranger are not a whole-table count each time', async () => {
  const { env, scans } = store();
  for (let i = 0; i < 10; i++) {
    const r = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/recent?x=${i}`), env, { waitUntil: () => {} });
    assert.equal(r.status, 200);
    const p = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/?y=${i}`), env, { waitUntil: () => {} });
    assert.equal(p.status, 200);
  }
  console.log('  MEASURED:', JSON.stringify({ requests: 20, wholeTableCounts: scans.length }));
  assert.ok(scans.length <= 1, `20 requests within seconds ran ${scans.length} counts over every row with json_extract`);
});
