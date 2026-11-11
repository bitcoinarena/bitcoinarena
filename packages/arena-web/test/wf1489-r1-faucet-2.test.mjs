// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-faucet-2: the explorer's minute read (readWindow -> merge) must not let ONE seat of the fourteen decide what an order is.
//  (a) a transaction only guardian-1 lists - an id no other seat holds, with a made-up entry - is stored and counted by /api/played as a real
//      player's round (realPlayers, the owner's measure of real play, and the Umami events built from the same rows);
//  (b) an order all fourteen seats hold as LOST is shown as WON with a payout when guardian-1 alone says so (merge takes the first non-pending result).
// Safe: a transaction one seat alone names is not counted, and one seat's result does not overrule thirteen others.
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

test('#1489 r1-faucet-2: one seat alone neither adds a played round nor sets an order\'s result in the explorer', async () => {
  const { env } = store();
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const FAKE = hex(0xf00d), REAL = hex(0xbeef), ROUND_F = hex(0x1111), ROUND_R = hex(0x2222);
  const order = (id, round, player, result) => ({ id, storedMs: now - 60000, detail: { known: true, seat: 'aa'.repeat(32), storedAt: at,
    entry: { round, app: 'rock-paper-scissors', player, stakeMsat: '100000' }, result } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/txs')) {
      const honest = order(REAL, ROUND_R, 'cc'.repeat(32), { state: 'lost', netMsat: '-100000', payoutMsat: '0' });
      if (seat === 'guardian-1') return ok({ txs: [order(FAKE, ROUND_F, 'ee'.repeat(32), { state: 'won', netMsat: '100000', payoutMsat: '200000' }),
        order(REAL, ROUND_R, 'cc'.repeat(32), { state: 'won', netMsat: '100000', payoutMsat: '200000' })] });
      return ok({ txs: [honest] });
    }
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  const fake = await (await call(env, '/api/tx/' + FAKE)).json();
  const honest = await (await call(env, '/api/tx/' + REAL)).json();
  const played = await (await call(env, '/api/played')).json();
  const today = played.day[0] ? played.day[0].all : null;
  const facts = { fakeStored: !!fake.found && fake.cached === true, fakeSeatsKnown: (fake.seats || []).filter((s) => s.known).length,
    honestResult: honest.result && honest.result.state, honestSeatsKnown: (honest.seats || []).filter((s) => s.known).length, today };
  console.log('  FACTS r1-faucet-2:', JSON.stringify(facts));
  assert.equal(honest.result.state, 'lost', 'one seat of fourteen turned an order thirteen seats hold as lost into won');
  assert.equal(today ? today.rounds : 0, 1, 'a round only one seat names is counted as played');
  assert.equal(today ? today.realPlayers : 0, 1, 'a made-up player only one seat names is counted as a real player');
});
