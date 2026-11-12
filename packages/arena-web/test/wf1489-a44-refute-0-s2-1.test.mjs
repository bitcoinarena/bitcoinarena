// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 0 skeptic 2 (#1599): TWO seats (AGREE=2), the reload path /api/tx, the fed_txid lookup, legacy rows.
// original header follows:
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


const TWO = new Set(['guardian-1', 'fed2-7']);
const kindOf = (db, id) => db.prepare('SELECT kind, round FROM txs WHERE id = ?').get(id) ?? null;

test('s2-1: two agreeing seats (AGREE=2) list a gift whose id is the order\'s id: the order stays an order', async () => {
  const { env, db } = store();
  await minute(env, () => null);
  await minute(env, (seat, u) => (TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const tx = await (await call(env, '/api/tx/' + REAL)).json();
  const totals = await (await call(env, '/api/totals')).json();
  console.log('  MEASURED two seats:', JSON.stringify({ row: kindOf(db, REAL), kind: tx.kind, totals: totals.all }));
  assert.equal(tx.kind || 'order', 'order');
  assert.equal(totals.all.rounds, 1);
});

test('s2-2: payment row first (the order not yet read), then the minute: the order takes its id back (honest resume)', async () => {
  const { env, db } = store();
  await minute(env, (seat, u) => (u.pathname.endsWith('/txs') ? ok({ txs: [] }) : TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const before = kindOf(db, REAL);
  await minute(env, (seat, u) => (TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const after = kindOf(db, REAL);
  console.log('  MEASURED pre-empt:', JSON.stringify({ before, after }));
  assert.equal(after.kind, 'order');
  assert.equal(after.round, ROUND);
});

test('s2-3: the reload path - the order first kept through GET /api/tx (txOf, had=null), then two seats\' gift row with its id', async () => {
  const { env, db } = store();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname.endsWith('/tx')) return ok(order.detail); return ok({}); };
  let w; try { await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + REAL), env, { waitUntil: (p) => { w = p; } }); await w; } finally { globalThis.fetch = real; }
  const first = kindOf(db, REAL);
  await minute(env, (seat, u) => (u.pathname.endsWith('/txs') ? ok({ txs: [] }) : TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const after = kindOf(db, REAL);
  console.log('  MEASURED reload path:', JSON.stringify({ first, after }));
  assert.equal(first.kind, 'order');
  assert.equal(after.kind, 'order');
});

test('s2-4: two seats list a gift with a FRESH id whose federation txid is the order\'s id: /api/tx/<order> still shows the order', async () => {
  const { env } = store();
  await minute(env, (seat, u) => (TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(hex(0xf1f1), REAL)], items: [] }) : null));
  const tx = await (await call(env, '/api/tx/' + REAL)).json();
  console.log('  MEASURED fed_txid alias, order stored:', JSON.stringify({ id: tx.id === REAL, kind: tx.kind, amountMsat: tx.amountMsat }));
  assert.equal(tx.kind || 'order', 'order');
  assert.equal(tx.id, REAL);
});

test('s2-5: fed_txid alias before the order is stored: /api/tx/<order> asks the seats instead of serving the seats\' gift', async () => {
  const { env } = store();
  await minute(env, (seat, u) => (u.pathname.endsWith('/txs') ? ok({ txs: [] }) : TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(hex(0xf2f2), REAL)], items: [] }) : null));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname.endsWith('/tx')) return ok(order.detail); return ok({}); };
  let tx; try { tx = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + REAL), env, { waitUntil: () => {} })).json(); } finally { globalThis.fetch = real; }
  console.log('  MEASURED fed_txid alias, order not yet stored:', JSON.stringify({ id: tx.id === REAL, kind: tx.kind, amountMsat: tx.amountMsat, cached: tx.cached }));
  assert.equal(tx.kind || 'order', 'order', 'an order\'s id shows a made-up 21M BTC gift');
});

// s2-6 (a legacy row with kind NULL) dropped: txs.kind is NOT NULL in the migrations, so no such row exists.

test('s2-7: honest path - a same-kind payment row still updates (a gift re-listed after one more seat keeps it)', async () => {
  const { env, db } = store();
  const G = hex(0xa7);
  const one = new Set(['guardian-1', 'guardian-2']);
  await minute(env, (seat, u) => (u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: one.has(seat) ? [gift(G, 'aa'.repeat(32))] : [], items: [] }) : null));
  const h1 = db.prepare('SELECT hash FROM txs WHERE id = ?').get(G).hash;
  await minute(env, (seat, u) => (u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(G, 'aa'.repeat(32))], items: [] }) : null));
  const r = db.prepare('SELECT hash, kind, json FROM txs WHERE id = ?').get(G);
  const kept = JSON.parse(r.json).seats.filter((s) => s.known).length;
  console.log('  MEASURED same-kind update:', JSON.stringify({ changed: h1 !== r.hash, kind: r.kind, kept }));
  assert.notEqual(h1, r.hash); assert.equal(kept, 14);
});

test('s2-8: the s2-2 window - a gift row holding the order\'s id before the order is read: /api/tx/<order> asks the seats and shows the order', async () => {
  const { env, db } = store();
  await minute(env, (seat, u) => (u.pathname.endsWith('/txs') ? ok({ txs: [] }) : TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(REAL, 'ab'.repeat(32))], items: [] }) : null));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname.endsWith('/tx')) return ok(order.detail); return ok({}); };
  let tx, w; try { tx = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + REAL), env, { waitUntil: (p) => { w = p; } })).json(); await w; } finally { globalThis.fetch = real; }
  console.log('  MEASURED gift row at the order id:', JSON.stringify({ kind: tx.kind, amountMsat: tx.amountMsat, row: kindOf(db, REAL) }));
  assert.equal(tx.kind || 'order', 'order');
  assert.equal(kindOf(db, REAL).kind, 'order');
});

test('s2-9: honest path - a real gift is still found by its id and by its federation txid when no seat holds an order there', async () => {
  const { env } = store();
  const G = hex(0xa9), T = hex(0xa9a9);
  await minute(env, (seat, u) => (TWO.has(seat) && u.pathname.endsWith('/payments') ? ok({ seat: hex(1), gifts: [gift(G, T)], items: [] }) : null));
  const real = globalThis.fetch;
  globalThis.fetch = async () => ok({ known: false });
  let a, b; try {
    a = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + G), env, { waitUntil: () => {} })).json();
    b = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + T), env, { waitUntil: () => {} })).json();
  } finally { globalThis.fetch = real; }
  console.log('  MEASURED honest gift:', JSON.stringify({ byId: [a.id === G, a.kind], byTxid: [b.id === G, b.kind] }));
  assert.equal(a.id, G); assert.equal(a.kind, 'donation');
  assert.equal(b.id, G); assert.equal(b.kind, 'donation');
});
