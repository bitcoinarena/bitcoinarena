// kanban #2985: the card's test (audit faucet r1-1 of 2026-11-18)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit faucet r1 #1 (P5, a gap in #2758's fix): GET /api/recent?fed=<64 hex> filters on txs.federation, a column with NO index. #2758 made a
// hex `q` read txs through its indexes (and #2540 bounds the TOTAL to 32 filters a minute), but the page query itself still runs on every
// request, uncached: a fed value that names no federation makes SQLite walk txs newest first (txs_stored_id) looking for 201 matches, every row
// read and its federation compared. Each fresh fed is a fresh URL; even the same URL runs it again.
// Safe: fresh non-matching fed filters do not each walk the whole table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
const ROWS = 2000;
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const seen = { sql: [] };
  const prepare = (sql) => { seen.sql.push(sql); const st = { b: [], bind: (...b) => { st.b = b; return st; },
    all: async () => ({ results: db.prepare(sql).all(...st.b) }), first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, 'nextblock', ?, ?, 'ACCEPTED', 'h', ?, 0)`);
  const fed = 'f'.repeat(64);
  for (let i = 1; i <= ROWS; i++) put.run((0xa000000 + i).toString(16).padStart(64, 'a'), (0xb000000 + (i >> 1)).toString(16).padStart(64, 'b'), fed, Date.UTC(2026, 10, 2) + i,
    JSON.stringify({ entry: { player: (0xc000000 + i).toString(16).padStart(64, 'c'), stakeMsat: '100000' } }));
  db.prepare("INSERT INTO marked (key, kind, at_ms) VALUES (?, 'bot', 0)").run('9'.repeat(64));   // one bot mark, as live
  return { db, seen, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    ASSETS: { fetch: async () => new Response('<html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}

test('audit faucet-r1-1: fresh non-matching fed filters on /api/recent do not each walk the whole txs table', async () => {
  const { db, env, seen } = store();
  const get = (fed) => worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/recent?fed=${fed}`), env, { waitUntil: () => {} });
  // the minute's 32 kept totals filled first (allowed by #2540), so only the page query runs below
  for (let i = 0; i < 32; i++) assert.equal((await get((0xd00 + i).toString(16).padStart(64, '0'))).status, 200);
  seen.sql.length = 0;
  const N = 20;
  for (let i = 0; i < N; i++) {
    const r = await get((0xe00 + i).toString(16).padStart(64, '1'));   // a 64-hex federation id no row names
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.txs.length, 0);
    assert.equal(j.total, null, 'the total is past its budget (#2540): only the page query reads txs');
  }
  const page = seen.sql.filter((q) => /^SELECT id, round, app/.test(q) && /federation = \?/.test(q)).at(-1);
  assert.ok(page, 'the page query ran');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + page).all('1'.repeat(64), 201).map((r) => r.detail);
  const visited = db.prepare(`SELECT COUNT(*) AS n FROM txs WHERE federation <> ?`).get('1'.repeat(64)).n;
  console.log('  MEASURED:', JSON.stringify({ rows: ROWS, requests: N, pageQueries: seen.sql.filter((q) => /^SELECT id, round, app/.test(q)).length, rowsEachWalks: visited }));
  console.log('  PLAN:', plan.join(' | '));
  assert.ok(!plan.some((d) => /^SCAN txs\b/.test(d)), `the fed page query walks txs: ${plan.join(' | ')}`);
});

