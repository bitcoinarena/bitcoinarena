// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-2-s2 / #2127 / #1602 (explorer Worker, honest path / retry of the walk): the walk now goes on from the AGREE-th
// smallest reach (AGREE = 2). When only two seats hold the old gifts (the seats that rolled GET /payments first; the others keep only what
// came after their roll) and the second keeps each gift a little later than the first (it was handed on to it), the walk goes on from the
// SECOND seat's reach - past gifts the first seat has not listed yet. On the next page the second seat no longer lists them (kept before
// since in its clock), so each is listed by one seat only, never by AGREE, and is never stored. 90d57151a (smallest reach) stored them.
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
const now = Date.now(), T0 = now - 10 * 24 * 3600000;   // old gifts: only the walk reads them
const gift = (i, keptMs) => ({ id: hex(0xc000 + i), kind: 'donation', item: 'donation', donor: 'd0'.repeat(32), gameName: 'rock-paper-scissors',
  federation: 'fe'.repeat(32), txid: hex(0xd000 + i), totalMsat: '1000', outputs: [], atMs: T0 + 10 * i, keptMs });
// guardian-1 kept gift i at T0 + 10 i; guardian-2 had it handed on and kept it 25 ms later; guardians 3-7 rolled later (none of them)
const rows = { 'guardian-1': Array.from({ length: 300 }, (_, i) => gift(i, T0 + 10 * i)), 'guardian-2': Array.from({ length: 300 }, (_, i) => gift(i, T0 + 10 * i + 25)) };
const page = (seat, since, limit) => ok({ seat: hex(Number(seat.split('-')[1])), gifts: (rows[seat] || []).filter((g) => g.keptMs > since).slice(0, limit), items: [] });

async function minute(env) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    if (u.pathname.endsWith('/payments')) return page(seat, Number(u.searchParams.get('since')), Number(u.searchParams.get('limit')));
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
}

test('two seats hold the old gifts, the second 25 ms behind: every gift both list is stored by the walk', async () => {
  const { env, db } = store();
  const walk = [];
  for (let m = 0; m < 4; m++) { await minute(env); walk.push(db.prepare("SELECT v FROM state WHERE k = 'payments-walk'").get()?.v ?? null); }
  const have = new Set(db.prepare('SELECT id FROM txs').all().map((r) => r.id));
  const missing = Array.from({ length: 300 }, (_, i) => i).filter((i) => !have.has(hex(0xc000 + i)));
  console.log('  MEASURED:', JSON.stringify({ walk: walk.map((v) => (v === 'done' ? v : Number(v) - T0)), stored: have.size, missing }));
  assert.deepEqual(missing, [], `gifts both seats list were never stored; walk (from T0) ${JSON.stringify(walk.map((v) => (v === 'done' ? v : Number(v) - T0)))}`);
});

// kanban #2392: the AGREE-th seat lists a gift a page (a minute) after the first - guardian-2 holds 200 rows of its own first (each only it
// lists), so its cursor is a page behind guardian-1's. guardian-1's listings not stored yet are kept and count with guardian-2's later page.
test('#2392: the second seat lists the gifts a minute later than the first - each is still stored', async () => {
  const { env, db } = store();
  const own = Array.from({ length: 200 }, (_, i) => ({ ...gift(1000 + i, T0 - 5000 + i), donor: 'e' + String(i).padStart(63, '0') }));
  const saved = rows['guardian-2'];
  rows['guardian-2'] = own.concat(saved);
  try {
    const walk = [];
    for (let m = 0; m < 5; m++) { await minute(env); walk.push(db.prepare("SELECT v FROM state WHERE k = 'payments-walk'").get()?.v ?? null); }
    const have = new Set(db.prepare('SELECT id FROM txs').all().map((r) => r.id));
    const missing = Array.from({ length: 300 }, (_, i) => i).filter((i) => !have.has(hex(0xc000 + i)));
    const ownStored = own.filter((g) => have.has(g.id)).length;
    console.log('  MEASURED a page behind:', JSON.stringify({ walk: walk.map((v) => (v === 'done' ? v : Number(v) - T0)), stored: have.size, missing, ownStored }));
    assert.deepEqual(missing, []);
    assert.equal(ownStored, 0, 'a row one seat alone lists is not stored');
    assert.equal(walk.at(-1), 'done');
  } finally { rows['guardian-2'] = saved; }
});
