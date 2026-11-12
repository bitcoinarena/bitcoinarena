// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-21 (#1510 second copy): paymentTx still builds a transaction from held[0] - ONE seat - and marks it found.
// guardian-1 alone lists a made-up item purchase (a player key, a game, 21 BTC): the explorer stores and serves it as a real transaction,
// the very thing #1510 stopped for orders ("an id fewer than AGREE seats hold ... is not found and not stored").
// Safe: a payment only one seat of 14 lists is not stored.
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

test('#1489 v1-refute-21: a payment only one seat lists is not stored as a transaction', async () => {
  const { db, env } = store();
  const now = Date.now(), FAKE = hex(0xfa4e);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) return ok(seat === 'guardian-1' ? { seat: 'ee'.repeat(32), gifts: [], items: [{ id: FAKE, kind: 'item', item: 'nextblock · large-truck',
      player: 'c0'.repeat(32), gameDev: 'de'.repeat(32), gameName: 'nextblock', itemId: 'large-truck', federation: 'fe'.repeat(32), txid: '99'.repeat(32),
      totalMsat: '2100000000000', outputs: [], keptMs: now - 30000 }] } : { gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  const row = db.prepare('SELECT id, kind, json FROM txs WHERE id = ?').get(FAKE);
  const seatsKnown = row ? JSON.parse(row.json).seats.filter((s) => s.known).length : 0;
  console.log('  FACTS v1-refute-21-2:', JSON.stringify({ stored: !!row, kind: row && row.kind, seatsKnown }));
  assert.equal(row, undefined, `a purchase only ${seatsKnown} seat of 14 lists is stored as a transaction`);
});
