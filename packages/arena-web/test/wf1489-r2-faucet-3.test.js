// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2 (site Worker): POST /__bench writes one KV key per request for anyone, with no limit (P5). Cloudflare's KV puts are an
// account-wide daily allowance (1,000 a day on the free tier - the explorer already hit it on 2026-10-26); a stranger's loop spends it, and the
// site's own CHAIN writes (chain-nodes, the season boards) and the explorer's health copy then fail for the rest of the day.
// Safe: one caller cannot make more than a handful of KV writes a day through /__bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../src/website/worker.js';

test('#1489-r2 #1536 one caller cannot write unlimited KV keys through POST /__bench', async () => {
  const puts = [];
  const env = { BENCH: { put: async (k, v) => { puts.push([k, v.length]); } }, CHAIN: { get: async () => null, put: async () => {} },
    ASSETS: { fetch: async () => new Response('x') } };
  for (let i = 0; i < 200; i++) {
    await worker.fetch(new Request('https://bitcoinarena.io/__bench', { method: 'POST', body: 'b',
      headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'stranger' } }), env, { waitUntil: () => {} });
  }
  console.log('  MEASURED: KV puts from one caller in 200 posts:', puts.length, 'bytes', puts.reduce((n, p) => n + p[1], 0));
  assert.ok(puts.length <= 20, `one caller made ${puts.length} KV writes`);
});
