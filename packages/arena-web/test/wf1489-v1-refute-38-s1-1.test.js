// kanban #1489 skeptic of #1536: the /__bench caps live in module memory of one isolate. Cloudflare runs the Worker in many isolates
// (every machine of every colo, recycled when idle), and each new isolate starts at zero - so a stranger with an IPv6 /48 (65,536 /64s)
// reaching a few dozen isolates still spends the account's 1,000 KV puts a day. Each fresh import below is one new isolate.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('#1489 refute #1536 (#1703, #1768): the bench cap does not bound KV puts across isolates', async () => {
  let puts = 0;
  const env = { BENCH: { put: async () => { puts++; } }, CHAIN: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  let caller = 0;
  for (let iso = 0; iso < 25; iso++) {
    const { default: worker } = await import(`../../../src/website/worker.js?isolate=${iso}`);
    for (let i = 0; i < 60; i++) {
      const ip = `2001:db8:${(caller >> 16).toString(16)}:${(caller & 0xffff).toString(16)}::1`; caller++;
      await worker.fetch(new Request('https://bitcoinarena.io/__bench', { method: 'POST', body: 'b', headers: { 'cf-connecting-ip': ip } }), env, { waitUntil: () => {} });
    }
  }
  console.log('  MEASURED: KV puts by one stranger over 25 isolates:', puts);
  assert.ok(puts < 1000, `one stranger made ${puts} BENCH puts - the account's daily 1,000 is gone`);
});
