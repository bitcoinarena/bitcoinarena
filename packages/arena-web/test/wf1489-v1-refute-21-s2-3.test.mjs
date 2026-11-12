// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-21 skeptic 2 (#1510 bypass, the reload path GET /api/tx/<id>): ONE SEAT STILL SAYS WHO PROCESSED A ROUND AND THE
// PAGE'S TIMING. merge() agrees the entry, locks, settlement and result, but `processed` (game and settlement committees, asker, outcome
// attestors, settledAt) is pick()ed from the FIRST seat that names each field, and `client` is the first seat's - guardian-1, SEATS[0].
// guardian-1 copies the honest entry and result and names itself the asker and sole attestor with a made-up settledAt: the explorer's
// readTx (a stranger's /api/tx/<id>) stores and serves that as the record, over 13 seats that agree otherwise.
// Safe: what processed a round and its client timing are what AGREE seats send, never one seat's alone.
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

test('#1489 v1-refute-21-s2: one seat does not say who processed a round or what the page timed', async () => {
  const { db, env } = store();
  const ID = hex(0xbeef), at = new Date(Date.now() - 60000).toISOString();
  const entry = { round: hex(0x2222), app: 'rock-paper-scissors', player: 'cc'.repeat(32), stakeMsat: '100000' };
  const result = { state: 'lost', netMsat: '-100000', payoutMsat: '0' };
  const honest = { game: ['a1', 'a2', 'a3'], settlement: ['a1', 'a2', 'a3'], asker: 'a1', outcomes: ['a1', 'a2', 'a3'], settledAt: at };
  const lie = { game: ['ee'], settlement: ['ee'], asker: 'ee', outcomes: ['ee'], settledAt: '2020-01-01T00:00:00.000Z' };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1], liar = seat === 'guardian-1';
    return new Response(JSON.stringify({ known: true, seat: liar ? 'ee'.repeat(32) : 'aa'.repeat(32), storedAt: at, entry, result,
      processed: liar ? lie : honest, client: liar ? { sentMs: 1, sig: 'forged' } : { sentMs: 500 } }), { headers: { 'content-type': 'application/json' } });
  };
  let tx;
  try { const waits = []; tx = await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/tx/' + ID), env, { waitUntil: (p) => waits.push(p) })).json(); await Promise.all(waits); }
  finally { globalThis.fetch = real; }
  const kept = JSON.parse(db.prepare('SELECT json FROM txs WHERE id = ?').get(ID).json);
  console.log('  FACTS v1-refute-21-s2-3:', JSON.stringify({ served: { asker: tx.processed.asker, settledAt: tx.processed.settledAt, client: tx.client }, kept: kept.processed.asker }));
  assert.equal(kept.processed.asker, 'a1', 'one seat of 14 named the asker: ' + kept.processed.asker);
  assert.equal(kept.processed.settledAt, at, 'one seat of 14 set when the round settled: ' + kept.processed.settledAt);
  assert.deepEqual(kept.client, { sentMs: 500 }, 'one seat of 14 set the page timing');
});
