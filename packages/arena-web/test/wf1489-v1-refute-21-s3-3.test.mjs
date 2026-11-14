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
// kanban #1489 v1-refute-21 skeptic 3 (merge() seats[].known): the entry is agreed and only the seats holding it speak, but each seat's
// row still says known = the seat's own body.known. A seat that sends a made-up entry under a real id is shown "Has it: yes" with its own
// stored time, and the page's "Nodes N of 14" counts it - paymentTx was fixed to known = the seat lists the agreed row, merge() was not.
// Safe: a seat whose entry is not the agreed one is not counted as holding the transaction.

test('#1489 v1-refute-21-s3: a seat with a made-up entry is not shown as holding the order', async () => {
  const { db, env } = store();
  const ID = hex(0xbeef), at = new Date(Date.now() - 60000).toISOString();
  const entry = { round: hex(0x2222), app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' };
  const fake = { ...entry, player: 'ee'.repeat(32), stakeMsat: '2100000000000' };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const seat = new URL(url).pathname.split('/')[1];
    const body = seat === 'guardian-1' || seat === 'guardian-2' ? { known: true, seat: 'aa'.repeat(32), storedAt: at, entry, result: { state: 'lost' } }
      : seat === 'fed2-7' ? { known: true, seat: 'ee'.repeat(32), storedAt: '2020-01-01T00:00:00.000Z', entry: fake, result: { state: 'won' } } : { known: false };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  try { const waits = []; await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + ID), env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); }
  finally { globalThis.fetch = real; }
  const kept = JSON.parse(db.prepare('SELECT json FROM txs WHERE id = ?').get(ID).json);
  const holding = kept.seats.filter((x) => x.known).map((x) => x.seat);
  console.log('  FACTS v1-refute-21-s3-3:', JSON.stringify({ entryPlayer: kept.entry.player.slice(0, 4), holding, liarStored: kept.seats.find((x) => x.seat === 'fed2-7').storedAt }));
  assert.deepEqual(holding, ['guardian-1', 'guardian-2'], 'the seat with a made-up entry is shown as holding the order');
});
