// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-21 (#1510 bypass): ONE SEAT STILL SAYS WHAT A TRANSACTION IS through the payments door. readWindow now stores an
// order only when 2 seats agree on its entry, but readPayments -> paymentTx takes a gift/item from the FIRST seat that lists it, with any id,
// and keep() upserts by id (ON CONFLICT(id) DO UPDATE ... kind = excluded.kind). guardian-1 alone lists a "gift" whose id is a real order's
// id: the order row turns into kind 'donation' with no round, so /api/played no longer counts the real player's round (and Umami never
// hears of it). poll() runs readWindow first and readPayments after, so the liar's row wins every minute.
// Safe: an order all 14 seats hold stays an order counted as a real player's round, whatever one seat lists under /payments.
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

async function minute(env, liarPayments) {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const REAL = hex(0xbeef), ROUND = hex(0x2222);
  const order = { id: REAL, storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
    entry: { round: ROUND, app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' }, result: { state: 'lost', netMsat: '-100000', payoutMsat: '0' } } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [order] });   // all 14 seats hold the honest order
    if (u.pathname.endsWith('/payments')) return ok(seat === 'guardian-1' ? liarPayments(REAL, now) : { gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  return REAL;
}
const liar = (id, now) => ({ seat: 'ee'.repeat(32), items: [], gifts: [{ id, kind: 'donation', item: 'donation', target: 3, donor: 'dd'.repeat(32),
  gameName: null, federation: 'fe'.repeat(32), txid: '77'.repeat(32), totalMsat: '1', outputs: [], keptMs: now - 30000 }] });

test('#1489 v1-refute-21: one seat\'s /payments row does not turn a 14-seat order into a gift and drop it from /api/played', async () => {
  const { db, env } = store();
  const REAL = await minute(env, liar);
  await minute(env, liar);   // a second minute: readWindow restores, readPayments overwrites again
  const row = db.prepare('SELECT kind, round FROM txs WHERE id = ?').get(REAL);
  const played = await (await call(env, '/api/played')).json();
  const today = played.day[0] ? played.day[0].all : null;
  console.log('  FACTS v1-refute-21-1:', JSON.stringify({ row, today }));
  assert.equal(row.kind, 'order', 'one seat turned an order fourteen seats hold into a ' + row.kind);
  assert.equal(today ? today.realPlayers : 0, 1, 'one seat removed a real player\'s round from /api/played');
});
