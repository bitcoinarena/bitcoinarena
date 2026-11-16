// wf1489 r25 client 1: ONE SEAT'S GET /exchange OFFER IS READ UP TO A BOUND. exchangeEcashInto (the stake lock's cross-federation
// exchange) reads each listed seat's offer with r.json(), no byte cap: one seat streaming a padded body has the whole of it pulled into
// the page's memory (and parsed) on every exchange. Safe: a seat's offer answer is cut off well before 64 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto } from '../src/ecash-transfer.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

test('a seat padding its GET /exchange offer is not read whole', async () => {
  const MB = 1 << 20; let pulled = 0;
  const chunk = new Uint8Array(MB).fill(0x20);
  const fetcher = async (url) => {
    assert.match(String(url), /\/exchange\?federations=/);
    const body = new ReadableStream({ pull(c) { if (pulled >= 256 * MB) { c.enqueue(new TextEncoder().encode('{}')); c.close(); return; } pulled += MB; c.enqueue(chunk); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const got = await exchangeEcashInto({ storage: memStore(), from: 'aa'.repeat(32), to: 'bb'.repeat(32), needMsat: 1000n, seats: ['https://evil.example'],
    walletFrom: {}, walletTo: async () => ({}), fetcher, offerTimeoutMs: 60000, put: (s, k, v) => s.setItem(k, v) });
  assert.equal(got.ok, false);
  assert.ok(pulled < 64 * MB, `the page pulled ${pulled / MB} MB of one seat's offer answer`);
});
