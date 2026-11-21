// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 0 skeptic 3 (#1599, #2201): the mirror of #1599. keep() lets ANY merged order take an id a payment row holds
// (WHERE ... OR excluded.kind = 'order') and txOf serves an order row at once; readPayments (#2201) now drops every gift whose federation
// txid is an order id in D1. So the same two agreeing seats (AGREE=2) that #2201 guards against can list a made-up ORDER in GET /txs:
//   s3-1  with a real gift's id: the gift row becomes their order (kind order, a round), /api/tx/<gift> shows it, and the gift never comes back
//   s3-2  with a real gift's federation txid, before the gift is read: the honest gift that all 14 seats list is never stored
//   s3-3  with a stored gift's federation txid: /api/tx/<fed txid> (what the wallet history links) shows their order, not the gift
// Safe: a real payment all seats list is neither replaced, hidden nor aliased by two seats' made-up order.
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
const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
const now = Date.now(), at = new Date(now - 60000).toISOString();
const G = hex(0x9a17), T = hex(0x7a7a);   // an honest gift and its federation txid, listed by all 14 seats
const gift = { id: G, kind: 'donation', item: 'donation', donor: 'd0'.repeat(32), gameName: 'rock-paper-scissors', federation: 'fe'.repeat(32),
  txid: T, totalMsat: '21000', outputs: [], atMs: now - 50000, keptMs: now - 50000 };
const fakeOrder = (id) => ({ id, storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
  entry: { round: hex(0x3333), app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' }, result: { state: 'won', netMsat: '100000', payoutMsat: '200000' } } });
const TWO = new Set(['guardian-1', 'fed2-7']);

async function minute(env, { orderId = null, gifts = true } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    if (u.pathname.endsWith('/txs')) return ok({ txs: orderId && TWO.has(seat) ? [fakeOrder(orderId)] : [] });
    if (u.pathname.endsWith('/payments')) return ok({ seat: hex(1), gifts: gifts ? [gift] : [], items: [] });
    if (u.pathname.endsWith('/tx')) return ok(orderId && TWO.has(seat) && u.searchParams.get('id') === orderId ? fakeOrder(orderId).detail : { known: false });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
}
async function txAt(env, id, orderId = null) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { const u = new URL(url), seat = u.pathname.split('/')[1];
    return ok(orderId && TWO.has(seat) && u.searchParams.get('id') === orderId ? fakeOrder(orderId).detail : { known: false }); };
  let w; try { const r = await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + id), { ...env }, { waitUntil: (p) => { w = p; } }); const j = await r.json(); await w; return j; }
  finally { globalThis.fetch = real; }
}
const rowOf = (db, id) => db.prepare('SELECT kind, round FROM txs WHERE id = ?').get(id) ?? null;

test('s3-1: two seats list a made-up order with a real gift\'s id: the gift stays a gift', async () => {
  const { env, db } = store();
  await minute(env);                          // the honest gift, all 14 seats
  const before = rowOf(db, G);
  await minute(env, { orderId: G });          // two seats: an "order" at the gift's id
  await minute(env, { orderId: G });          // and the next minute: does the gift come back?
  const tx = await txAt(env, G, G);
  console.log('  MEASURED order over gift:', JSON.stringify({ before, after: rowOf(db, G), kind: tx.kind || 'order', cached: tx.cached }));
  assert.equal(before.kind, 'donation');
  assert.equal(rowOf(db, G).kind, 'donation', 'two seats turned a real gift into their made-up order');
  assert.equal(tx.kind, 'donation');
});

test('s3-2: two seats list a made-up order whose id is a real gift\'s federation txid: the gift all 14 seats list is still stored', async () => {
  const { env, db } = store();
  await minute(env, { orderId: T, gifts: false });   // the order first (the gift not yet listed)
  await minute(env, { orderId: T });                 // then every seat lists the honest gift
  await minute(env, { orderId: T });
  const tx = await txAt(env, G);
  console.log('  MEASURED gift hidden by an order at its txid:', JSON.stringify({ giftRow: rowOf(db, G), byId: [tx.found, tx.kind] }));
  assert.ok(rowOf(db, G), 'the honest gift (14 of 14 seats) is never stored');
  assert.equal(tx.kind, 'donation');
});

test('s3-3: a stored gift, then two seats\' order at its federation txid: /api/tx/<txid> (the wallet history\'s link) still shows the gift', async () => {
  const { env } = store();
  await minute(env);
  const first = await txAt(env, T);
  await minute(env, { orderId: T });
  const tx = await txAt(env, T, T);
  console.log('  MEASURED by txid:', JSON.stringify({ first: [first.id === G, first.kind], after: [tx.id === G, tx.kind || 'order', tx.cached] }));
  assert.equal(first.kind, 'donation');
  assert.equal(tx.kind, 'donation', 'the wallet history\'s link shows two seats\' made-up order');
});

test('s3-4: honest path - the gift alone is stored and found by its id and its txid', async () => {
  const { env, db } = store();
  await minute(env);
  const a = await txAt(env, G), b = await txAt(env, T);
  console.log('  MEASURED honest:', JSON.stringify({ row: rowOf(db, G), byId: a.kind, byTxid: [b.id === G, b.kind] }));
  assert.equal(a.kind, 'donation'); assert.equal(b.id, G);
});
