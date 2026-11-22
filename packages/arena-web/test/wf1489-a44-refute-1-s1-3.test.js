// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-1 (skeptic of #1600) (explorer Worker, role: ONE seat of the fourteen): one seat's GET /txs list with a null element (or GET /payments
// with a null row) threw in readWindow / readPayments, so the minute's read of EVERY seat's orders (or payments) stopped (P4).
// Safe: one seat's junk drops only that seat's rows; the other thirteen are still stored.
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
const call = (env, path) => worker.fetch(new Request('https://explorer.bitcoinarena.io' + path), env, { waitUntil: () => {} });
const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
const REAL = hex(0xbeef), ROUND = hex(0x2222);
const now = Date.now(), at = new Date(now - 60000).toISOString();
const order = { id: REAL, storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
  entry: { round: ROUND, app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' }, result: { state: 'lost', netMsat: '-100000', payoutMsat: '0' } } };
const gift = (id, txid, keptMs = now - 50000) => ({ id, kind: 'donation', item: 'donation', donor: 'd0'.repeat(32), gameName: 'rock-paper-scissors', federation: 'fe'.repeat(32),
  txid, totalMsat: '2100000000000000000', outputs: [], atMs: keptMs, keptMs });

async function minute(env, answer) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const a = answer(seat, u); if (a) return a;
    if (u.pathname.endsWith('/txs')) return ok({ txs: [order] });
    if (u.pathname.endsWith('/payments')) return ok({ seat: hex(1), gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
}
const playedToday = async (env) => { const p = await (await call(env, '/api/played')).json(); return p.day[0] ? p.day[0].all : null; };


test('#1489 a44-refute-1-3: one seat\'s null element in GET /referral-fees programs does not stop the metrics read of every seat', async () => {
  const { db, env } = store();
  const fees = { programs: [{ site: 'a.example', name: 'A', atMs: 1 }], sites: [{ site: 'a.example', msat: '1000', payouts: 1 }] };
  await minute(env, (seat, u) => (u.pathname.endsWith('/referral-fees') ? ok(seat === 'fed2-7' ? { ...fees, programs: [...fees.programs, null] } : fees)
    : u.pathname.endsWith('/reserves') ? ok({ federations: [{ federationId: 'fe'.repeat(32), heldMsat: '5000' }] }) : null));
  const row = db.prepare("SELECT v FROM state WHERE k = 'metrics'").get();
  const m = row && row.v ? JSON.parse(row.v) : null;
  console.log('  MEASURED null program: metrics kept =', m ? m.reserve.msat + ' reserve / ' + m.referral.msat + ' referral' : null);
  assert.ok(m, 'the metrics thirteen seats report are kept');
  assert.equal(m.reserve.msat, '5000');
});
