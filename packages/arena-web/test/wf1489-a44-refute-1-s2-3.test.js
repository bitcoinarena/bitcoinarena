// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-1 skeptic 2 (of #1600): one seat that holds an order answers storedAt = the earliest other seat's storedAt (public GET /tx) + 'x': it sorts second, becomes storedFirst, Date.parse gives NaN, stored_ms NOT NULL fails and the write batch of every seat's orders throws
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
const state = (db, k) => { const r = db.prepare('SELECT v FROM state WHERE k = ?').get(k); return r ? r.v : null; };

test('#1489 a44-refute-1-s2-3: one seat\'s storedAt that sorts second but is no date does not stop every seat\'s orders from being stored', async () => {
  const { env } = store();
  const POISON = hex(0xdead);
  const seats = [1, 2, 3, 4, 5, 6, 7].map((i) => `guardian-${i}`).concat([1, 2, 3, 4, 5, 6, 7].map((i) => `fed2-${i}`));
  // each seat kept it at its own millisecond (as on the live seats); guardian-1's is the earliest
  const S = (i) => new Date(now - 70000 + i).toISOString();
  const poison = (seat) => ({ ...order, id: POISON, storedMs: now - 70000, detail: { ...order.detail, entry: { ...order.detail.entry, player: 'ee'.repeat(32) },
    storedAt: seat === 'fed2-7' ? S(0) + 'x' : S(seats.indexOf(seat)) } });
  await minute(env, (seat, u) => (u.pathname.endsWith('/txs') ? ok({ txs: [poison(seat), order] }) : null));
  const today = await playedToday(env);
  console.log('  MEASURED storedAt S+"x" from one seat: played today =', JSON.stringify(today));
  assert.equal(today ? today.rounds : 0, 1, 'the orders thirteen seats hold are stored');
});
