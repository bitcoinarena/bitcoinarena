// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2): the explorer worker against 14 seats, with one store kept across several scheduled runs (the
// 5-minute and hourly re-reads), and the clock set so the run reads what the test wants (minute 0: metrics, minute 7: reserve history).
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
export function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  return { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } };
}
export const FED = 'fe'.repeat(32);
const HOUR = 3600000;
// answer(seat, path, url) -> body (null: the seat does not answer in time) or undefined for the default; minute: the clock's minute of the hour
export async function runOn(env, answer, minute = 0) {
  const real = globalThis.fetch, realNow = Date.now;
  const at = Math.floor(realNow() / HOUR) * HOUR + minute * 60000;
  Date.now = () => at;
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
  try { let done; await worker.scheduled({ scheduledTime: at }, env, { waitUntil: (p) => { done = p; } }); await done; }
  finally { globalThis.fetch = real; Date.now = realNow; }
  return (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/metrics'), env, { waitUntil: () => {} })).json();
}
