// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit faucet a8 r3-1 (gap in #3323): #3323 made live() refuse a non-object answer and paintNetwork check that protocols is a list, but the
// other per-node doors are still read by shape. One bonded census node that answers GET /liquidity-claim with { channels: 1 } (paintLiquidity:
// (c.channels || []).reduce) or GET /dashboard.json with { settlements: "x" } (keepable: (d.settlements || []).map) makes readHealth throw, so
// the explorer's /api/health copy is never written again while that node answers so (the live page says "could not read the network").
// Safe: one node's odd answer is that node's row only; the copy is still built and stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHealth, HEALTH_DAILY } from '../../../src/website/explorer/health.js';

const K = (i) => String(i).padStart(2, '0').repeat(32);
const DAILY = { testnet: { node: ['https://s1.example/a', 'https://s2.example/b'] } };
const NODES = [{ node: K(1), endpoint: 'wss://n1.example', roles: ['signer'] }, { node: K(3), endpoint: 'https://evil.example', roles: [] }];
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 120, nodes: NODES },
  'https://s2.example/b/roles': { censusHeight: 120, nodes: NODES },
  'https://s1.example/a/fees': { tip: 157000 },
  'https://s2.example/b/fees': { tip: 157000 },
  'https://s1.example/a/federations': { federations: [{ federation: K(9), height: 5, status: 'OPEN', signers: [K(1)] }] },
  'https://n1.example/owner/version': { version: '2026.1.9', protocols: [16], machine: { id: 'm1' } },
  'https://evil.example/owner/version': { version: '2026.1.9', protocols: [16], machine: { id: 'm3' } },
};
function network(evilPath, evilBody) {
  return async (url) => {
    const u = String(url), path = u.replace(/\?.*/, '');
    if (u === HEALTH_DAILY) return new Response(JSON.stringify(DAILY));
    if (evilPath && path === `https://evil.example${evilPath}`) return new Response(evilBody);
    const body = DOORS[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
  };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };

for (const [name, path, evil] of [['no odd answer (control)', null, null], ['/liquidity-claim { channels: 1 }', '/liquidity-claim', '{"lightningPubkey":"02ab","freeSats":1,"channels":1}'],
  ['/dashboard.json { settlements: "x" }', '/dashboard.json', '{"node":"x","settlements":"x"}']]) {
  test(`one census node answering ${name} does not stop the health copy`, async (t) => {
    t.mock.method(console, 'log', () => {});
    const EXPLORER = kv();
    let err = null;
    try { await readHealth({ EXPLORER }, network(path, evil)); } catch (e) { err = e; }
    console.error(`  MEASURED (${name}): readHealth ${err ? `threw: ${err.message}` : 'ok'}; copy stored: ${EXPLORER.m.has('health')}`);
    assert.equal(err, null, `one node's ${path} answer stopped the health copy: ${err && err.message}`);
    assert.ok(EXPLORER.m.has('health'), 'no health copy was stored');
  });
}
