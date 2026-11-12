// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-faucet (explorer Worker, role: ONE seat of the fourteen):
//  1. one seat's GET /txs list with a null element (or GET /payments with a null row) throws in readWindow / readPayments, so the
//     minute's read of EVERY seat's orders stops: nothing is stored, /api/played counts nothing (P4).
//  2. one seat's GET /payments row whose id is an order's entry id overwrites that order's txs row (kind -> donation, round -> NULL):
//     the round leaves /api/played, /api/totals and the volume, and /api/tx shows the seat's made-up gift (P3 + P8).
//  3. a gift only one seat lists is stored and shown (paymentTx takes held[0], no agreement as #1510 gave the orders) (P8).
//  4. one seat that fills its /payments page with keptMs 0 holds the payments walk at its start for ever (P4).
// Safe: one seat's answer neither stops, replaces nor invents what the other thirteen agree on.
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

test('#1489 r4-faucet-1: one seat\'s null element in GET /txs does not stop the explorer reading the thirteen others', async () => {
  const { env } = store();
  await minute(env, (seat, u) => (seat === 'fed2-7' && u.pathname.endsWith('/txs') ? ok({ txs: [order, null] }) : null));
  const today = await playedToday(env);
  console.log('  MEASURED null in /txs: played today =', JSON.stringify(today));
  assert.equal(today ? today.rounds : 0, 1, 'the order thirteen seats hold is stored and counted');
});

test('#1489 r4-faucet-1b: one seat\'s null row in GET /payments does not stop every seat\'s gifts from being stored', async () => {
  const { env } = store();
  const G = hex(0xa1);
  await minute(env, (seat, u) => (u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: seat === 'fed2-7' ? [gift(G, 'aa'.repeat(32)), null] : [gift(G, 'aa'.repeat(32))], items: [] }) : null));
  const r = await call(env, '/api/recent?kind=donation');
  const body = await r.json();
  console.log('  MEASURED null in /payments: donations stored =', body.total);
  assert.equal(body.total, 1, 'the gift thirteen seats list is stored');
});

test('#1489 r4-faucet-2: one seat\'s /payments row naming an order\'s id does not replace the order', async () => {
  const { env } = store();
  await minute(env, (seat, u) => (seat === 'guardian-1' && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const tx = await (await call(env, '/api/tx/' + REAL)).json();
  const today = await playedToday(env);
  const totals = await (await call(env, '/api/totals')).json();
  console.log('  MEASURED order overwritten:', JSON.stringify({ kind: tx.kind, entry: tx.entry, amountMsat: tx.amountMsat, today, totals: totals.all }));
  assert.equal(tx.kind || 'order', 'order', 'the order thirteen seats hold is still an order');
  assert.equal(today ? today.rounds : 0, 1, 'the round is still counted as played');
  assert.equal(totals.all.rounds, 1);
});

test('#1489 r4-faucet-3: a gift only one seat of fourteen lists is not stored', async () => {
  const { env } = store();
  const FAKE = hex(0xf00d);
  await minute(env, (seat, u) => (seat === 'guardian-1' && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(FAKE, 'ac'.repeat(32))], items: [] }) : null));
  const body = await (await call(env, '/api/recent?kind=donation')).json();
  console.log('  MEASURED one-seat gift:', JSON.stringify(body.txs.map((t) => ({ id: t.id.slice(-4), stakeMsat: t.stakeMsat }))));
  assert.equal(body.total, 0, 'a 21M BTC gift named by one seat alone is shown in the explorer');
});

test('#1489 r4-faucet-4: one seat\'s full /payments page of keptMs 0 does not hold the payments walk at its start', async () => {
  const { env, db } = store();
  const page = Array.from({ length: 200 }, (_, i) => gift(hex(0xc000 + i), hex(0xd000 + i), 0));
  const walk = [];
  for (let m = 0; m < 3; m++) {
    await minute(env, (seat, u) => (u.pathname.endsWith('/payments') && seat === 'guardian-1' && u.searchParams.get('limit') === '200' ? ok({ seat: hex(1), gifts: page, items: [] }) : null));
    walk.push(db.prepare("SELECT v FROM state WHERE k = 'payments-walk'").get()?.v ?? null);
  }
  console.log('  MEASURED payments-walk after 3 minutes:', JSON.stringify(walk));
  assert.ok(walk.at(-1) === 'done' || Number(walk.at(-1)) > 0, 'the walk moves on (or ends) after one seat\'s page of keptMs 0');
});
