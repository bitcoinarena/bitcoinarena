// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-21 skeptic 2 (#1510/#1696 bypass, the RESUME path): ONE SEAT STILL SAYS WHERE THE PAYMENTS WALK GOES ON FROM.
// readPayments computes `next` as the earliest last keptMs of ANY seat's list that is filled to the limit - before any agreement and even
// before the row's id is checked. guardian-1 alone answers 200 junk rows whose last keptMs is 0: the walk stores 'payments-walk' = 0 every
// minute and never gets past the first page, so every honest gift older than READ_BACK_MS beyond the first 200 is never stored.
// Safe: with 13 honest seats listing 250 old gifts the same way, the walk reaches all 250 whatever one seat answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} }, UMAMI_SEND: 'off' } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
const GIFTS = Array.from({ length: 250 }, (_, i) => ({ id: hex(0x1000 + i), kind: 'donation', item: 'donation', target: 0, donor: 'dd'.repeat(32), gameDev: null,
  gameName: null, origin: null, federation: 'fe'.repeat(32), txid: hex(0x9000 + i), totalMsat: '1000', outputs: [], atMs: 1000 + i, keptMs: 1000 + i }));

async function minute(env, liar) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) {
      const since = Number(u.searchParams.get('since')), limit = Number(u.searchParams.get('limit'));
      if (liar && seat === 'guardian-1') return ok({ seat: 'ee'.repeat(32), items: [], gifts: Array.from({ length: limit }, () => ({ keptMs: 0 })) });
      return ok({ seat: 'aa'.repeat(32), items: [], gifts: GIFTS.filter((g) => g.keptMs > since).slice(0, limit) });
    }
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
}

test('#1489 v1-refute-21-s2: the payments walk without a liar reaches every old gift (control)', async () => {
  const { db, env } = store();
  for (let i = 0; i < 4; i++) await minute(env, false);
  const n = db.prepare("SELECT COUNT(*) AS n FROM txs WHERE kind = 'donation'").get().n;
  assert.equal(n, 250);
});

test('#1489 v1-refute-21-s2: one seat does not hold the payments walk at its first page', async () => {
  const { db, env } = store();
  for (let i = 0; i < 6; i++) await minute(env, true);
  const n = db.prepare("SELECT COUNT(*) AS n FROM txs WHERE kind = 'donation'").get().n;
  const walk = db.prepare("SELECT v FROM state WHERE k = 'payments-walk'").get();
  console.log('  FACTS v1-refute-21-s2-1:', JSON.stringify({ stored: n, walk }));
  assert.equal(n, 250, 'one seat kept ' + (250 - n) + ' honest gifts out of the explorer for good (walk at ' + (walk && walk.v) + ')');
});
