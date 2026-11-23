// kanban #3043: the card's test
// Audit 2026-11-19 r3, faucet 2 (P5 no limits, P4 one of n blocks all): the explorer's health copy (src/website/explorer/health.js readHealth, run
// by health-push.mjs every 3 min and pushed to the Worker's KV key 'health', served at GET /api/health) asks every census node's own doors
// (/owner/version, /owner/bond, /liquidity-claim, /gateway-claim, /founding, /uptime) through network.js live(), which reads r.json() whole, and
// keepable() keeps every such answer whole in the copy. One bonded census node that answers /owner/bond with a 26 MiB padded JSON makes the copy
// larger than a Cloudflare KV value may be (25 MiB): `wrangler kv key put` is refused every run while it pads, and the health page shows an
// ever older copy; below that limit every health page visitor downloads the node's padding.
// Safe: one node's answer cannot grow the kept copy past what KV takes (each kept answer bounded, or the oversize one dropped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHealth, HEALTH_DAILY } from '../../../src/website/explorer/health.js';

const K = (i) => String(i).padStart(2, '0').repeat(32);
const DAILY = { testnet: { node: ['https://s1.example/a'] } };
const NODES = [{ node: K(1), endpoint: 'https://honest.example', roles: ['signer'], bondSats: '50000' }, { node: K(2), endpoint: 'https://padder.example', roles: ['signer'], bondSats: '50000' }];
const KV_VALUE_MOST = 25 * 1024 * 1024;   // Cloudflare Workers KV: the most one value may be
const PAD = 26 * 1024 * 1024;

test('audit-faucet-r3-2: one census node\'s padded /owner/bond answer does not grow the health copy past what KV takes', async (t) => {
  t.mock.method(console, 'log', () => {});
  const doors = {
    'https://s1.example/a/roles': { censusHeight: 120, nodes: NODES },
    'https://s1.example/a/fees': { tip: 157000 },
    'https://honest.example/owner/version': { version: '2026.1.9', protocols: [16] },
    'https://padder.example/owner/version': { version: '2026.1.9', protocols: [16] },
    'https://honest.example/owner/bond': { bondSats: '50000' },
  };
  const padded = `{"bondSats":"50000","note":"${'x'.repeat(PAD)}"}`;
  const net = async (url) => {
    const u = String(url), path = u.replace(/\?.*/, '');
    if (u === HEALTH_DAILY) return new Response(JSON.stringify(DAILY));
    if (path === 'https://padder.example/owner/bond') return new Response(padded, { headers: { 'content-type': 'application/json' } });
    const body = doors[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ why: 'no such door here' }), { status: 404 });
  };
  const m = new Map();
  // the KV the copy goes to refuses a value over its limit, as Cloudflare KV (and wrangler kv key put) does
  const EXPLORER = { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { if (String(v).length > KV_VALUE_MOST) throw new Error(`KV value is ${String(v).length} bytes, over ${KV_VALUE_MOST}`); m.set(k, v); } };
  let err = null;
  try { await readHealth({ EXPLORER, HEALTH_BUDGET: 5000, HEALTH_AT_ONCE: 32 }, net); } catch (e) { err = e; }
  console.log('  MEASURED:', JSON.stringify({ stored: m.has('health'), bytes: m.has('health') ? m.get('health').length : null, error: err ? String(err.message).slice(0, 120) : null }));
  assert.equal(err, null, `the health copy could not be kept: ${err && err.message}`);
  assert.ok(m.has('health') && m.get('health').length <= KV_VALUE_MOST, 'the health copy fits a KV value');
});
