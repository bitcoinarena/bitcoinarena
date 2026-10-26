// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXPLORER'S STORE, PAGED, WITH EVERY KIND OF PAYMENT (kanban #683, 2026-10-26: "I don't see item purchases in the explorer and I don't see
// other apps in the explorer. Add paging to the explorer to display more than a 1000"; #682: a gift "doesn't show in the explorer"). The
// Worker over D1 as node:sqlite with its migrations, KV as a Map, the seats as a fetch that answers /txs, /payments, /reserves, /referral-fees.
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
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } }, kv };
}
const hex = (n) => n.toString(16).padStart(64, '0');
const ask = async (env, path) => (await worker.fetch(new Request('https://explorer.bitcoin-arena.io' + path), env, { waitUntil: () => {} })).json();

test('a page of 200 newest first, older and newer pages by a row\'s cursor; every app in the filters, not only the newest 1000\'s', async () => {
  const { db, env } = store();
  const put = db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, ?, ?, ?, NULL, 'h', ?, 0)`);
  // 1,400 rows: the newest 1,200 Up/Down, below them 150 Tick Tock and 50 RPS - what the live store holds (2026-10-26: the newest 1000 all Up/Down)
  for (let i = 0; i < 1400; i++) {
    const app = i < 1200 ? 'btc-updown-15m' : i < 1350 ? 'nextblock' : 'rock-paper-scissors';
    put.run(hex(i + 1), hex(9000 + i), app, 'fe'.repeat(32), 1_800_000_000_000 - i * 1000, JSON.stringify({ entry: { stakeMsat: '100000' } }));
  }
  const first = await ask(env, '/api/recent');
  assert.deepEqual([first.txs.length, first.total, first.newer, first.txs[0].id, first.txs[199].id], [200, 1400, null, hex(1), hex(200)]);
  assert.equal(first.older, `${1_800_000_000_000 - 199000}_${hex(200)}`);
  assert.deepEqual(first.facets.apps, [{ app: 'btc-updown-15m', n: 1200 }, { app: 'nextblock', n: 150 }, { app: 'rock-paper-scissors', n: 50 }]);
  assert.deepEqual(first.txs[0].kind, 'order');
  // walking older to the last page: 1,400 rows in 7 pages, each row once
  const seen = new Set(first.txs.map((t) => t.id));
  let page = first, pages = 1;
  while (page.older) { page = await ask(env, '/api/recent?before=' + page.older); pages++; for (const t of page.txs) { assert.ok(!seen.has(t.id)); seen.add(t.id); } }
  assert.deepEqual([pages, seen.size, page.txs.at(-1).id], [7, 1400, hex(1400)]);
  // and back: newer than the second page's first row is the first page itself
  const second = await ask(env, '/api/recent?before=' + first.older);
  assert.equal(second.newer, `${1_800_000_000_000 - 200000}_${hex(201)}`);
  const back = await ask(env, '/api/recent?after=' + second.newer);
  assert.deepEqual([back.txs[0].id, back.txs.length, back.newer], [hex(1), 200, null]);
  const third = await ask(env, '/api/recent?before=' + second.older);
  const up = await ask(env, '/api/recent?after=' + third.newer);
  assert.deepEqual([up.txs[0].id, up.txs.at(-1).id, up.newer, up.older], [hex(201), hex(400), second.newer, second.older], 'the second page again');
  // one app, read in the store, not among the page's rows: RPS is below the newest 1,350
  const rps = await ask(env, '/api/recent?app=rock-paper-scissors&limit=20');
  assert.deepEqual([rps.total, rps.txs.length, rps.txs.every((t) => t.app === 'rock-paper-scissors'), rps.txs[0].id], [50, 20, true, hex(1351)]);
  const rps3 = await ask(env, '/api/recent?app=rock-paper-scissors&limit=20&before=' + (await ask(env, '/api/recent?app=rock-paper-scissors&limit=20&before=' + rps.older)).older);
  assert.deepEqual([rps3.txs.length, rps3.older], [10, null]);
  // part of an id
  const q = await ask(env, '/api/recent?q=' + hex(1399).slice(-4));
  assert.ok(q.txs.some((t) => t.id === hex(1399)));
});

test('the gifts, zaps and items bought are rows of their own kind, each found by its id and by its federation transaction; not stakes', async () => {
  const { db, env, kv } = store();
  const now = Date.now();
  const gift = { id: hex(0xa1), kind: 'donation', item: 'donation · protocol + rock-paper-scissors · from app:rock-paper-scissors', target: 3, donor: 'd0'.repeat(32), gameDev: 'de'.repeat(32),
    gameName: 'rock-paper-scissors', origin: 'app:rock-paper-scissors', federation: 'fe'.repeat(32), txid: 'aa'.repeat(32), totalMsat: '1000000',
    outputs: [{ outIdx: 0, pk: '02' + '11'.repeat(32), msat: '500000' }, { outIdx: 1, pk: '02' + '12'.repeat(32), msat: '500000' }], atMs: now - 70000 };
  const zap = { ...gift, id: hex(0xa2), kind: 'zap', item: 'zap', target: 2, gameName: null, origin: null, txid: 'ab'.repeat(32), totalMsat: '21000', outputs: [{ outIdx: 0, pk: '02' + '13'.repeat(32), msat: '21000' }] };
  const item = { id: hex(0xb1), kind: 'item', item: 'nextblock · large-truck', player: 'c0'.repeat(32), gameDev: 'de'.repeat(32), gameName: 'nextblock', itemId: 'large-truck',
    gameId: null, priceSat: '500', federation: 'fe'.repeat(32), txid: 'bb'.repeat(32), totalMsat: '500000', outputs: [{ outIdx: 0, pk: '02' + '14'.repeat(32), msat: '500000' }], atMs: now - 50000 };
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url); asked.push(u.pathname);
    const seat = Number(/-(\d)$/.exec(u.pathname.split('/')[1])[1]);
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    // seat 7 of each federation runs the code before GET /payments: 404
    if (u.pathname.endsWith('/payments')) return seat === 7 ? new Response('not found', { status: 404 })
      : ok({ seat: hex(seat), gifts: [{ ...gift, keptMs: now - 60000 + seat }, { ...zap, keptMs: now - 59000 }], items: [{ ...item, keptMs: now - 40000 + seat }] });
    return ok({});
  };
  try {
    let done; await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } }); await done;
  } finally { globalThis.fetch = real; }
  assert.ok(asked.some((p) => p.endsWith('/payments')));
  // the walk's position in D1, not KV (2026-10-26: the KV free tier's 1,000 puts a day were spent by the minute's writes)
  assert.equal(db.prepare("SELECT v FROM state WHERE k = 'payments-walk'").get().v, 'done', 'the walk from the first: nothing over');
  assert.equal(kv.size, 0, 'no KV write');
  const page = await ask(env, '/api/recent');
  assert.deepEqual(page.txs.map((t) => [t.kind, t.app, t.stakeMsat, t.item]), [['item', 'nextblock', '500000', 'nextblock · large-truck'], ['zap', null, '21000', 'zap'],
    ['donation', 'rock-paper-scissors', '1000000', 'donation · protocol + rock-paper-scissors · from app:rock-paper-scissors']]);
  assert.deepEqual((await ask(env, '/api/recent?kind=item')).txs.map((t) => t.id), [hex(0xb1)]);
  const g = await ask(env, '/api/tx/' + hex(0xa1));
  assert.deepEqual([g.found, g.kind, g.payment.origin, g.payment.outputs.length, g.storedFirst, g.seats.length], [true, 'donation', 'app:rock-paper-scissors', 2, new Date(now - 60000 + 1).toISOString(), 14]);
  assert.deepEqual([g.seats.filter((s) => s.known).length, g.seats.find((s) => s.seat === 'guardian-7').status], [12, 404]);
  // the wallet history's link names the gift's federation transaction (kanban #682)
  assert.equal((await ask(env, '/api/tx/' + 'aa'.repeat(32))).id, hex(0xa1));
  assert.equal((await ask(env, '/api/tx/' + 'bb'.repeat(32))).payment.itemId, 'large-truck');
  const m = await ask(env, '/api/metrics');
  assert.deepEqual(m.volume, [], 'gifts and items are no stakes: the day\'s volume is the orders\'');
  assert.deepEqual(page.facets.kinds.map((k) => k.kind).sort(), ['donation', 'item', 'zap']);
});
