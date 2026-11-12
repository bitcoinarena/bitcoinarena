// kanban #1489 skeptic of #1536: a second stranger door to the same KV allowance - GET /api/season. When a kept board is older than 30 min
// (or missing) every request starts readSeason, and each one ends in env.CHAIN.put. The check is "is the kept copy stale", not "is a read already
// running", so concurrent requests during the 5-13 s a seat takes each write their own put.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../src/website/worker.js';

test('#1489 refute #1536 (#1703, #1768): concurrent GET /api/season on a stale board each write a CHAIN key', async () => {
  const store = new Map([['season:nextblock:7', `{"at":${Date.now() - 3600000},"season":{}}`]]);
  let puts = 0;
  const env = { CHAIN: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { puts++; store.set(k, v); } },
    BENCH: { put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { await new Promise((r) => setTimeout(r, 50)); return new Response('{"rows":[]}'); };
  try {
    const waits = [];
    await Promise.all(Array.from({ length: 200 }, () => worker.fetch(new Request('https://bitcoinarena.io/api/season?game=nextblock&days=7'), env, { waitUntil: (p) => waits.push(p) })));
    await Promise.all(waits);
  } finally { globalThis.fetch = realFetch; }
  console.log('  MEASURED: CHAIN puts from 200 concurrent GET /api/season:', puts);
  assert.ok(puts <= 20, `200 stranger GETs made ${puts} KV writes`);
});

test('#1489 refute #1536 (#1703, #1768): concurrent GET /api/season on a board never kept each write a CHAIN key', async () => {
  const store = new Map();
  let puts = 0;
  const env = { CHAIN: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { puts++; store.set(k, v); } },
    BENCH: { put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { await new Promise((r) => setTimeout(r, 50)); return new Response('{"rows":[]}'); };
  try {
    await Promise.all(Array.from({ length: 200 }, () => worker.fetch(new Request('https://bitcoinarena.io/api/season?game=rock-paper-scissors&days=90'), env, { waitUntil: () => {} })));
  } finally { globalThis.fetch = realFetch; }
  console.log('  MEASURED: CHAIN puts from 200 concurrent GET /api/season (cold):', puts);
  assert.ok(puts <= 20, `200 stranger GETs made ${puts} KV writes`);
});
