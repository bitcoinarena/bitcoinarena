// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Kanban #3752 (gap in #3323): every door a census node answers itself is read in the shape the cards read, so one node's field of the wrong
// type is that node's only - the health read still runs and the explorer's /api/health copy is still stored. The ticket's two doors are in
// audit-faucet-a8-3-1; these are the others the read takes from one node's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHealth, HEALTH_DAILY } from '../../../src/website/explorer/health.js';
import { nodeAnswer } from '../../../src/arena-ui/health/network.js';

const K = (i) => String(i).padStart(2, '0').repeat(32);
const DAILY = { testnet: { node: ['https://s1.example/a'] } };
const NODES = [{ node: K(1), endpoint: 'wss://n1.example', roles: ['signer'] }, { node: K(3), endpoint: 'https://evil.example', roles: [], guardianOf: [K(9)] }];
const DOORS = {
  'https://s1.example/a/roles': { censusHeight: 120, nodes: NODES },
  'https://s1.example/a/fees': { tip: 157000 },
  'https://s1.example/a/federations': { federations: [{ federation: K(9), height: 5, status: 'OPEN', signers: [K(1)] }] },
  'https://n1.example/owner/version': { version: '2026.1.9', protocols: [16], machine: { id: 'm1' } },
  'https://evil.example/owner/version': { version: '2026.1.9', protocols: [16], machine: { id: 'm3' } },
};
const ODD = [
  ['/founding seated [null], codes 1', '/founding', { id: 'f1', seated: [null, 7], codes: 1, alternates: 'x', ready: { cohort: 5 } }],
  ['/founding codes [null]', '/founding', { id: 'f1', seated: [K(3)], codes: [null], ready: { cohort: { height: 3 } } }],
  ['/founding?members=1 nodes 1', '/founding?members=1', { members: { nodes: 1, needed: 10 } }],
  ['/uptime windows [null]', '/uptime', { windows: [null], sinceMs: 'x' }],
  ['/uptime sinceMs not a time', '/uptime', { windows: [{ key: '24h', share: 1, partial: true }], sinceMs: 'x' }],
  ['/owner/version machine id 5', '/owner/version', { version: '2026.1.9', protocols: [16], machine: { id: 5, load: 'x' } }],
  ['/owner/version protocols ["x"]', '/owner/version', { version: {}, protocols: ['x'] }],
  ['/liquidity-seating providers 1', '/liquidity-seating', { providers: 1 }],
  ['/liquidity-seating providers [null]', '/liquidity-seating', { providers: [null] }],
  ['/liquidity-claim channels [null], funds 1', '/liquidity-claim', { lightningPubkey: '02ab', channels: [null], funds: 1 }],
  ['/dashboard.json settlements [null], byGame 1, hosts.lnd 1', '/dashboard.json', { settlements: [null], byGame: 1, hosts: { lnd: 1 }, totals: 'x' }],
  ['/owner/bond bond 1, lock "x"', '/owner/bond', { bond: 1, lock: 'x' }],
  ['/dashboard.json a list', '/dashboard.json', []],
];
function network(evilPath, evilBody) {
  return async (url) => {
    const u = String(url), path = u.replace(/\?(?!members=1$).*$/, '');
    if (u === HEALTH_DAILY) return new Response(JSON.stringify(DAILY));
    if (path === `https://evil.example${evilPath}`) return new Response(JSON.stringify(evilBody));
    // the evil node's founding names a cohort, so the members list is asked of it
    if (evilPath === '/founding?members=1' && path === 'https://evil.example/founding') return new Response(JSON.stringify({ id: 'f1', ready: { cohort: { height: 3 } } }));
    const body = DOORS[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
  };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };

for (const [name, path, body] of ODD) {
  test(`one census node answering ${name} does not stop the health copy`, async (t) => {
    t.mock.method(console, 'log', () => {});
    const EXPLORER = kv();
    let err = null;
    try { await readHealth({ EXPLORER }, network(path, body)); } catch (e) { err = e; }
    assert.equal(err, null, `one node's ${path} answer stopped the health copy: ${err && err.message}`);
    assert.ok(EXPLORER.m.has('health'), 'no health copy was stored');
  });
}

test('nodeAnswer keeps a well-formed answer and reshapes only the odd fields', () => {
  const good = { ok: true, ms: 3, body: { lightningPubkey: '02ab', freeSats: 5, channels: [{ capacitySats: 7 }], funds: [1] } };
  assert.deepEqual(nodeAnswer('/liquidity-claim', good).body.channels, [{ capacitySats: 7 }]);
  assert.deepEqual(nodeAnswer('/liquidity-claim', { ok: true, body: { channels: 1 } }).body.channels, []);
  assert.deepEqual(nodeAnswer('/dashboard.json', { ok: true, body: { settlements: [null, { madeMs: 9 }] } }).body.settlements, [{ madeMs: 9 }]);
  assert.deepEqual(nodeAnswer('/owner/version', { ok: true, body: { protocols: [16, 'x', 15] } }).body.protocols, [16, 15]);
  assert.equal(nodeAnswer('/owner/version', { ok: true, body: { protocols: 5 } }).body.protocols, undefined);
  assert.equal(nodeAnswer('/uptime', { ok: true, body: { windows: 'x' } }).body.windows, null);
  assert.equal(nodeAnswer('/liquidity-seating', { ok: true, body: { providers: [{ node: 'k', weight: 1 }] } }).body.providers.length, 1);
  assert.equal(nodeAnswer('/dashboard.json', { ok: true, body: [] }).ok, false);
  const bad = { ok: false, status: 404, why: 'x', ms: 1 };
  assert.equal(nodeAnswer('/owner/bond', bad), bad);
});
