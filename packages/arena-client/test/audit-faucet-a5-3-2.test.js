// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit faucet r3-2: one bonded census node whose GET /owner/version answers the JSON text `null` (or { protocols: 5 }) makes the whole
// health read throw (paintNetwork reads n.version.body.protocols), so read() is false, readHealth throws "the health read failed" and the
// explorer's /api/health copy is never written again while that node answers so (the live page shows "could not read the network" too).
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
};
function network(evilVersion) {
  return async (url) => {
    const u = String(url), path = u.replace(/\?.*/, '');
    if (u === HEALTH_DAILY) return new Response(JSON.stringify(DAILY));
    if (path === 'https://evil.example/owner/version') return new Response(evilVersion);
    const body = DOORS[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
  };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };

for (const [name, evil] of [['a normal answer (control)', '{"version":"x","protocols":[16]}'], ['null', 'null'], ['protocols: 5', '{"version":"x","protocols":5}']]) {
  test(`one census node answering /owner/version with ${name} does not stop the health copy`, async (t) => {
    t.mock.method(console, 'log', () => {});
    const EXPLORER = kv();
    let err = null;
    try { await readHealth({ EXPLORER }, network(evil)); } catch (e) { err = e; }
    console.error(`  MEASURED (${name}): readHealth ${err ? `threw: ${err.message}` : 'ok'}; copy stored: ${EXPLORER.m.has('health')}`);
    assert.equal(err, null, `one node's /owner/version answer stopped the health copy: ${err && err.message}`);
    assert.ok(EXPLORER.m.has('health'), 'no health copy was stored');
  });
}
