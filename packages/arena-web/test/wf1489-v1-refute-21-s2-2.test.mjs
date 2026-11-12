// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-21 skeptic 2 (#1510 bypass by volume): ONE SEAT STILL DECIDES THAT NO ORDER IS STORED. readWindow looks up in D1
// EVERY id any one seat lists (one query per 90 ids) before it asks whether AGREE seats hold it, and nothing caps a seat's list at the
// `limit` it was asked for. Cloudflare D1 allows 1000 queries per Worker invocation; guardian-1 alone lists 95,000 made-up ids, the
// lookups pass the budget, readWindow throws before its writes, and poll() (readWindow uncaught, first) never reaches readPayments either:
// the order all 14 seats hold and the gift they all hold are never stored, every minute the liar keeps it up.
// Safe: an order and a gift all 14 seats hold are stored whatever one seat lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
const D1_QUERIES = 1000;   // Cloudflare D1: queries per Worker invocation (Workers Paid)
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const budget = { n: 0 };
  const count = () => { if (++budget.n > D1_QUERIES) throw new Error('D1_ERROR: Too many API requests by single worker invocation.'); };
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => { count(); return { results: db.prepare(sql).all(...st.b) }; },
    first: async () => { count(); return db.prepare(sql).get(...st.b) ?? null; }, run: async () => { count(); return db.prepare(sql).run(...st.b); } }; return st; };
  return { db, budget, env: { DB: { prepare, batch: async (l) => { count(); for (const s of l) { budget.n--; await s.run(); } } },
    EXPLORER: { get: async () => null, put: async () => {} }, UMAMI_SEND: 'off' } };
}
const hex = (n) => n.toString(16).padStart(64, '0');

async function minute(s, flood) {
  s.budget.n = 0;   // one scheduled run is one invocation
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const REAL = hex(0xbeef), ROUND = hex(0x2222), GIFT = hex(0xcafe);
  const order = { id: REAL, storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
    entry: { round: ROUND, app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' }, result: { state: 'lost', netMsat: '-100000', payoutMsat: '0' } } };
  const gift = { id: GIFT, kind: 'donation', item: 'donation', target: 0, donor: 'dd'.repeat(32), gameDev: null, gameName: null, origin: null,
    federation: 'fe'.repeat(32), txid: '77'.repeat(32), totalMsat: '1000', outputs: [], atMs: now - 30000, keptMs: now - 30000 };
  const fake = flood ? Array.from({ length: 95000 }, (_, i) => ({ id: hex(0x100000 + i), storedMs: now - 60000, detail: { known: true } })) : [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: seat === 'guardian-1' ? [order, ...fake] : [order] });
    if (u.pathname.endsWith('/payments')) return ok({ seat: 'aa'.repeat(32), items: [], gifts: [gift] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, s.env, { waitUntil: (p) => { done = p; } }); await done.catch(() => null); } finally { globalThis.fetch = real; }
  return { REAL, GIFT };
}

test('#1489 v1-refute-21-s2: without a flood the minute stores the order and the gift (control)', async () => {
  const s = store();
  const { REAL, GIFT } = await minute(s, false);
  assert.equal(s.db.prepare('SELECT kind FROM txs WHERE id = ?').get(REAL)?.kind, 'order');
  assert.equal(s.db.prepare('SELECT kind FROM txs WHERE id = ?').get(GIFT)?.kind, 'donation');
});

test('#1489 v1-refute-21-s2: one seat listing 95,000 made-up ids does not keep a 14-seat order and gift out of D1', async () => {
  const s = store();
  const { REAL, GIFT } = await minute(s, true);
  await minute(s, true);
  const order = s.db.prepare('SELECT kind FROM txs WHERE id = ?').get(REAL), gift = s.db.prepare('SELECT kind FROM txs WHERE id = ?').get(GIFT);
  console.log('  FACTS v1-refute-21-s2-2:', JSON.stringify({ order, gift, queries: s.budget.n }));
  assert.equal(order && order.kind, 'order', 'one seat kept an order fourteen seats hold out of the explorer');
  assert.equal(gift && gift.kind, 'donation', 'one seat kept a gift fourteen seats hold out of the explorer');
});
