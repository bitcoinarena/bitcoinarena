// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-faucet-3 / #1601 (explorer Worker, role: ONE seat of the fourteen): a gift only one seat lists is not stored or shown
// (paymentTx took held[0], no agreement as #1510 gave the orders); a payment two seats agree on byte for byte is, and one seat cannot
// rewrite its amount (P8).
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

test('#1489 r4-faucet-3: a gift only one seat of fourteen lists is not stored', async () => {
  const { env } = store();
  const FAKE = hex(0xf00d);
  await minute(env, (seat, u) => (seat === 'guardian-1' && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(FAKE, 'ac'.repeat(32))], items: [] }) : null));
  const body = await (await call(env, '/api/recent?kind=donation')).json();
  console.log('  MEASURED one-seat gift:', JSON.stringify(body.txs.map((t) => ({ id: t.id.slice(-4), stakeMsat: t.stakeMsat }))));
  assert.equal(body.total, 0, 'a 21M BTC gift named by one seat alone is shown in the explorer');
});

test('#1601: a gift AGREE seats list the same is stored, and one seat cannot rewrite its amount', async () => {
  const { env } = store();
  const G = hex(0xa2);
  await minute(env, (seat, u) => (u.pathname.endsWith('/payments')
    ? ok({ seat: hex(1), gifts: [seat === 'guardian-1' ? { ...gift(G, 'ad'.repeat(32)), totalMsat: '999' } : { ...gift(G, 'ad'.repeat(32)), totalMsat: '5000' }], items: [] }) : null));
  const tx = await (await call(env, '/api/tx/' + G)).json();
  console.log('  MEASURED agreed gift:', JSON.stringify({ kind: tx.kind, amountMsat: tx.amountMsat }));
  assert.equal(tx.kind, 'donation');
  assert.equal(tx.amountMsat, '5000', 'the amount thirteen seats agree on, not the one guardian-1 alone sends');
});
