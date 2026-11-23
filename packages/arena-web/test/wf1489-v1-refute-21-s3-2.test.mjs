// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../src/website/explorer/worker.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const writes = { n: 0 };
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => { if (/^INSERT INTO txs/.test(sql)) writes.n++; return db.prepare(sql).run(...st.b); } }; return st; };
  return { db, writes, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} }, UMAMI_SEND: 'off' } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
// kanban #1489 v1-refute-21 skeptic 3 (the last first-seat copy in merge(): processed.names): who processed a round is now agreed, but each
// key's NAME is still one seat's word - names = fromEntries over every answering seat's own body.seat, the LAST seat wins a key two seats
// claim, and a seat that does not even hold the entry counts. fed2-7 (SEATS[13]) answers with seat = the asker's key: the stored record
// and the page say fed2-7 submitted the settlement and attested, though guardian-1 did. Safe: one seat cannot take another seat's key.

test('#1489 v1-refute-21-s3: one seat does not rename who processed a round', async () => {
  const { db, env } = store();
  const ID = hex(0xbeef), at = new Date(Date.now() - 60000).toISOString();
  const entry = { round: hex(0x2222), app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' };
  const K1 = 'a1'.repeat(32);
  const processed = { game: [K1], settlement: [K1], asker: K1, outcomes: [{ attestors: [K1], observedAt: at }], settledAt: at };
  const keyOf = (seat) => (seat === 'fed2-7' ? K1 : Buffer.from(seat.padEnd(32, '.')).toString('hex'));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const seat = new URL(url).pathname.split('/')[1];
    if (seat === 'guardian-1') { /* the honest asker */ }
    const body = seat === 'fed2-7' ? { known: false, seat: K1 } : { known: true, seat: seat === 'guardian-1' ? K1 : keyOf(seat), storedAt: at, entry, result: { state: 'lost' }, processed };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  let tx;
  try { const waits = []; tx = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + ID), env, { waitUntil: (p) => waits.push(p) })).json(); await Promise.all(waits); }
  finally { globalThis.fetch = real; }
  const kept = JSON.parse(db.prepare('SELECT json FROM txs WHERE id = ?').get(ID).json);
  console.log('  FACTS v1-refute-21-s3-2:', JSON.stringify({ asker: kept.processed.asker === K1, askerNamed: kept.processed.names[K1], served: tx.processed.names[K1] }));
  assert.notEqual(kept.processed.names[K1], 'fed2-7', 'one seat that does not hold the order took the asker key: the page names fed2-7 as asker and attestor');
});
