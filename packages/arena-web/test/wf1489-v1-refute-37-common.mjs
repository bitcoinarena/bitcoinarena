// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534: shared harness - the explorer worker against 14 seats, one of them (fed2-7) lying.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  return { env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } }, kv };
}
export const FED = 'fe'.repeat(32);
// answer(seat, path, url) -> body or undefined for the default
export async function runWith(answer) {
  const { env, kv } = store();
  const real = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    const mine = answer(seat, u.pathname, u);
    if (mine !== undefined) return ok(mine);
    if (u.pathname.endsWith('/reserves')) return ok({ federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [] }] });
    if (u.pathname.endsWith('/referral-fees')) return ok({ sites: [], programs: [] });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) return ok({ gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => { done = p; } }); await done; }
  finally { globalThis.fetch = real; Date.now = realNow; }
  const m = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/metrics'), env, { waitUntil: () => {} })).json();
  return { m, kv };
}
