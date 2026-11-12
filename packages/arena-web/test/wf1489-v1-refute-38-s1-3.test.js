// kanban #1489, #1703, #1768: the honest paths after the fix - a run carrying the bench key is stored (per caller, a /64 by its address);
// a run without it, or with a wrong key, is answered ok and stored nowhere; a cached season board is served, and the cron still writes the 7-day ones
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../src/website/worker.js';

const KEY = 'k'.repeat(24);
test('#1703 bench: stored only with the key; per caller by /64', async () => {
  const keys = [];
  const env = { BENCH_KEY: KEY, BENCH: { put: async (k) => { keys.push(k); } }, CHAIN: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  const post = (ip, q = `?key=${KEY}`) => worker.fetch(new Request(`https://bitcoinarena.io/__bench${q}`, { method: 'POST', body: 'run', headers: { 'cf-connecting-ip': ip } }), env, { waitUntil: () => {} });
  assert.equal(await (await post('198.51.100.9', '')).text(), 'ok'); assert.equal(keys.length, 0, 'no key: not stored');
  await post('198.51.100.9', '?key=' + 'x'.repeat(24)); assert.equal(keys.length, 0, 'wrong key: not stored');
  assert.equal(await (await post('198.51.100.9')).text(), 'ok'); assert.equal(keys.length, 1);
  for (let i = 0; i < 5; i++) await post('2001:db8:1:2::' + i.toString(16));
  assert.equal(keys.length, 6);
  await post('2001:0DB8:0001:0002:0:0:0:ff'); assert.equal(keys.length, 6, 'same /64 spelled long is the same caller');
  await post('2001:db8:1:3::1'); assert.equal(keys.length, 7);
  const noKey = { ...env, BENCH_KEY: undefined };
  await worker.fetch(new Request(`https://bitcoinarena.io/__bench?key=`, { method: 'POST', body: 'x', headers: { 'cf-connecting-ip': '198.51.100.77' } }), noKey, {});
  assert.equal(keys.length, 7, 'no BENCH_KEY set: nothing stored');
});

test('#1768 season: a cold board is read once and served; the cron writes the 7-day boards to KV', async () => {
  const store = new Map(); let puts = 0, reads = 0;
  const env = { CHAIN: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { puts++; store.set(k, v); } }, ASSETS: { fetch: async () => new Response('x') } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { if (String(u).includes('/season?')) { reads++; await new Promise((r) => setTimeout(r, 20)); return new Response('{"rows":[{"player":"a"}]}'); } throw new Error('no'); };
  try {
    const rs = await Promise.all(Array.from({ length: 30 }, () => worker.fetch(new Request('https://bitcoinarena.io/api/season?game=btc-updown-15m&days=30'), env, { waitUntil: () => {} })));
    for (const r of rs) { assert.equal(r.status, 200); assert.deepEqual(JSON.parse(await r.text()).season, { rows: [{ player: 'a' }] }); }
    assert.equal(reads, 3, 'one read (to each of the three seats) for 30 requests'); assert.equal(puts, 0);
    const again = await worker.fetch(new Request('https://bitcoinarena.io/api/season?game=btc-updown-15m&days=30'), env, { waitUntil: () => {} });
    assert.equal(again.status, 200); assert.equal(reads, 3, 'a fresh copy is served from memory');
    const waits = [];
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 12, 10, 0) }, { ...env, CHAIN: { ...env.CHAIN, get: async (k, t) => (k === 'chain:testnet4' ? null : env.CHAIN.get(k, t)) } }, { waitUntil: (p) => waits.push(p) }).catch(() => {});
    await Promise.all(waits);
    assert.ok(store.has('season:nextblock:7') && store.has('season:rock-paper-scissors:7') && store.has('season:btc-updown-15m:7'), 'the cron kept the 7-day boards');
  } finally { globalThis.fetch = realFetch; }
});
