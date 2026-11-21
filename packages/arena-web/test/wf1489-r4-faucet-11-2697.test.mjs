// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-faucet-11 (explorer Worker, role: a stranger who only knows the public explorer URL): GET /api/tx/<64 hex> for an id D1 does
// not hold - or any id with ?fresh - runs readTx, which asks all FOURTEEN seats GET /tx?id= at once, every time: nothing is cached for an id no
// seat holds (the 404 is answered no-store), and there is no per-caller bound. One stranger's loop of made-up ids is multiplied 14x onto the
// seats (all behind tn4.bitcoin-arena.io), from Cloudflare's network (P5: a stranger grows the work without limit).
// Safe: one caller's 50 requests for ids nobody holds make a bounded number of seat reads (here: at most 5 requests' worth, 70).
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

test('#1489 r4-faucet-11: one stranger\'s requests for made-up ids are not multiplied 14x onto the seats without bound', async () => {
  const { env } = store();
  const real = globalThis.fetch;
  let seatReads = 0;
  globalThis.fetch = async (url) => { if (String(url).includes('/tx?id=')) seatReads++; return new Response(JSON.stringify({ known: false }), { status: 404 }); };
  const statuses = [];
  try {
    for (let i = 0; i < 50; i++) {
      const id = (0x5000 + i).toString(16).padStart(64, '0');
      const r = await worker.fetch(new Request(`https://explorer.bitcoinarena.io/api/tx/${id}${i % 2 ? '?fresh=1' : ''}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }),
        env, { waitUntil: () => {} });
      statuses.push(r.status);
    }
  } finally { globalThis.fetch = real; }
  console.log('  MEASURED: 50 GET /api/tx/<made-up id> from one address ->', seatReads, 'seat reads; statuses', JSON.stringify([...new Set(statuses)]));
  assert.ok(seatReads <= 70, `one caller's 50 requests made ${seatReads} reads of the seats`);
});
