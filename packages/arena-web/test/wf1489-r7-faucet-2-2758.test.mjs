// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2758, #1489 r7 faucet 2 (P5, a way round #2540): GET /api/recent (and the explorer's home page /, which inlines the same list) keeps its TOTAL to
// one count a minute per filter and at most RECENT_TOTAL_KEYS (32) filters - but the page query itself is not bounded. A `q` that is hex and matches
// no row (q=ffff..., a fresh value each request) makes the page read walk every row of txs newest first looking for 201 matches, with instr() over
// three columns per row and the default marked-hidden filter's json_extract over each row's stored json - the D1 read #1459 ran out of memory on.
// Each new value is a new URL, so a stranger runs one whole-table scan per request, with no key, after the 32 kept totals are full as before.
// Safe: once the minute's totals are full, further GET /api/recent with fresh non-matching q values do not each walk the whole table.
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
  const seen = { instr: 0, sql: [] };
  // instr() counted: one call per row (and column) the filter is evaluated on
  db.function('instr', { deterministic: true }, (a, b) => { seen.instr++; return a === null || b === null ? null : String(a).indexOf(String(b)) + 1; });
  const prepare = (sql) => { seen.sql.push(sql); const st = { b: [], bind: (...b) => { st.b = b; return st; },
    all: async () => ({ results: db.prepare(sql).all(...st.b) }), first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, 'nextblock', 'fe', ?, 'ACCEPTED', 'h', ?, 0)`);
  for (let i = 1; i <= ROWS; i++) put.run((0xa000000 + i).toString(16).padStart(64, 'a'), (0xb000000 + (i >> 1)).toString(16).padStart(64, 'b'), Date.UTC(2026, 10, 2) + i,
    JSON.stringify({ entry: { player: (0xc000000 + i).toString(16).padStart(64, 'c'), stakeMsat: '100000' } }));
  return { db, seen, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    ASSETS: { fetch: async () => new Response('<html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}

test('#1489-r7-faucet-2 a stranger\'s fresh non-matching q filters do not each walk the whole table once the kept totals are full', async () => {
  const { db, env, seen } = store();
  const get = (q) => worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/recent?q=${q}`), env, { waitUntil: () => {} });
  // the minute's 32 kept totals filled first (allowed by #2540)
  for (let i = 0; i < 32; i++) assert.equal((await get((0xd00 + i).toString(16) + '0'.repeat(10))).status, 200);
  seen.instr = 0;
  const N = 20;
  for (let i = 0; i < N; i++) {
    const r = await get((0xe00 + i).toString(16) + 'f'.repeat(20));   // hex, matches no id, round or federation txid
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.txs.length, 0);
  }
  const rowsPerRequest = seen.instr / N;
  console.log('  MEASURED:', JSON.stringify({ rows: ROWS, requests: N, instrCalls: seen.instr, perRequest: rowsPerRequest }));
  assert.ok(seen.instr <= 2 * ROWS, `${N} requests with fresh non-matching q made ${seen.instr} instr() calls (${rowsPerRequest} each): a whole-table walk per request`);
  // kanban #2758: and the page query those requests ran reads txs through its indexes (id, round, fed_txid), never by walking it
  const page = seen.sql.filter((q) => /^SELECT id, round, app/.test(q) && /id >= \?/.test(q)).at(-1);
  assert.ok(page, 'the prefix page query ran');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + page).all(...Array(6).fill('e00').map((v, i) => (i % 2 ? 'e00g' : v)), 201).map((r) => r.detail);
  assert.ok(!plan.some((d) => /^SCAN txs\b/.test(d)) && /^SEARCH txs USING INDEX sqlite_autoindex_txs_1 \(id=\?\)/.test(plan[0]), plan.join(' | '));
  console.log('  PLAN:', plan.join(' | '));
});

test('kanban #2758: a whole id is an exact match, a part of one inside the budget is found anywhere, past it by its start', async () => {
  const { env } = store();
  const ids = (j) => j.txs.map((t) => t.id);
  const get = async (q) => (await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/recent?q=${q}&marked=1`), env, { waitUntil: () => {} })).json();
  const one = (0xa000000 + 7).toString(16).padStart(64, 'a');
  assert.deepEqual(ids(await get(one)), [one], 'a whole id');
  assert.ok(ids(await get(one.slice(-6))).includes(one), 'a part of it, anywhere, inside the budget');
  for (let i = 0; i < 32; i++) await get((0xd00 + i).toString(16) + '0'.repeat(10));
  assert.deepEqual(ids(await get(one.slice(-5))), [], 'past the budget a part from its middle finds nothing');
  assert.ok(ids(await get(one.slice(0, 63))).includes(one), 'past the budget its start still finds it');
  assert.deepEqual(ids(await get(one)), [one], 'and a whole id still does');
});
