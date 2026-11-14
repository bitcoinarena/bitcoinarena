// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const writes = { n: 0 };
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => { if (/^INSERT INTO txs/.test(sql)) writes.n++; return db.prepare(sql).run(...st.b); } }; return st; };
  return { db, writes, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} }, UMAMI_SEND: 'off' } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
// kanban #1489 v1-refute-21 skeptic 3 (merge damage in 4edb52939): readWindow now keeps D1's whole row ({ id, hash, kind }) in `hashes`
// and passes that object to keep() as `had`; keep() compares `had === h` with the hash string, never equal, so EVERY order of the last
// 3 h (up to 500 per seat list) is written to D1 again every minute ("only where it changed" is gone). readPayments was changed to pass
// had.hash; readWindow was not. Safe: an order no seat changed is not written again the next minute.

const NOW = Date.now();
async function minute(s) {
  const now = NOW, at = new Date(now - 60000).toISOString();
  const order = { id: hex(0xbeef), storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
    entry: { round: hex(0x2222), app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' }, result: { state: 'lost', netMsat: '-100000', payoutMsat: '0' } } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: Number(u.searchParams.get('since')) < now - 4 * 3600000 ? [] : [order] });
    if (u.pathname.endsWith('/payments')) return ok({ seat: 'aa'.repeat(32), items: [], gifts: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, s.env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
}

test('#1489 v1-refute-21-s3: an unchanged order is not written to D1 again every minute', async () => {
  const s = store();
  await minute(s);
  const first = s.writes.n;
  await minute(s);
  console.log('  FACTS v1-refute-21-s3-1:', JSON.stringify({ firstMinute: first, secondMinute: s.writes.n - first }));
  assert.equal(first, 1, 'the first minute stores the order');
  assert.equal(s.writes.n - first, 0, 'the second minute wrote the same unchanged order again');
});
