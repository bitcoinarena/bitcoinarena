// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2 (faucet/site/explorer): ONE SEAT OF 14 DECIDES THE EXPLORER'S PROTOCOL RESERVE. readMetrics takes, per federation, the
// LARGEST heldMsat any seat says (P8), and BigInt() of one seat's malformed heldMsat throws for the whole read (P4), so the Metrics page keeps
// a stale or a made-up reserve. Safe: one seat's answer neither sets nor stops the reserve the 13 others agree on.
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
  const kv = new Map();
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}
const FED = 'fe'.repeat(32);
async function runWith(bad) {
  const { env } = store();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/reserves')) return ok({ federations: [{ federationId: FED, heldMsat: seat === 'fed2-7' ? bad : '1000000', paidIn: [] }] });
    if (u.pathname.endsWith('/referral-fees')) return ok({ sites: [], programs: [] });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) return ok({ gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  return (await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/metrics'), env, { waitUntil: () => {} })).json());
}

test('#1489-r2 one seat of 14 does not set the protocol reserve the explorer shows', async () => {
  const m = await runWith('2100000000000000000');
  console.log('  MEASURED inflated:', JSON.stringify(m.reserve));
  assert.ok(m.reserve, 'metrics were read');
  assert.equal(m.reserve.msat, '1000000', 'the reserve 13 seats agree on, not one seat\'s 21M BTC');
});

test('#1489-r2 one seat\'s malformed heldMsat does not stop the metrics for everyone', async () => {
  const m = await runWith('not-a-number');
  console.log('  MEASURED junk:', JSON.stringify({ reserve: m.reserve, readAt: m.readAt }));
  assert.ok(m.reserve, 'the metrics are kept although one seat answered junk');
  assert.equal(m.reserve.msat, '1000000');
});
