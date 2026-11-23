// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r23-faucet-1 (explorer Worker, role: ONE seat of the fourteen, P5): the minute's read asks every seat GET /txs and ask()
// takes the whole answer with r.text() - no byte bound. One seat answering a valid JSON list padded with whitespace to hundreds of MB makes
// the Worker buffer all of it (a Worker has 128 MB): the invocation dies and no seat's orders are stored that minute.
// Safe: a seat's answer is read only up to a bound and the stream is cancelled past it.
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
  return { env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} }, UMAMI_SEND: 'off' } };
}
const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
const MB = 1024 * 1024, PAD_MB = 160;

test('#1489 r23-faucet-1: one seat\'s padded GET /txs answer is not read whole by the explorer', async () => {
  const { env } = store();
  let pulled = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), seat = u.pathname.split('/')[1];
    if (seat === 'fed2-7' && u.pathname.endsWith('/txs')) {
      const chunk = new TextEncoder().encode(' '.repeat(MB));
      let sent = 0;
      const body = new ReadableStream({ pull(c) {
        if (sent === 0) { c.enqueue(new TextEncoder().encode('{"txs":[]')); sent++; return; }
        if (sent <= PAD_MB) { c.enqueue(chunk); pulled += MB; sent++; return; }
        c.enqueue(new TextEncoder().encode('}')); c.close(); } });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) return ok({ seat: '01'.repeat(32), gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  console.log(`  MEASURED one seat's padded /txs: the explorer pulled ${Math.round(pulled / MB)} MiB of it`);
  assert.ok(pulled <= 32 * MB, `the explorer read ${Math.round(pulled / MB)} MiB of one seat's answer (a Worker has 128 MB)`);
});
