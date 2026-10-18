// THE LIQUIDITY PROVIDER SERVICE (§23A.10, kanban #494): two providers and a new node, through each other's claims - the node gets at
// least one and at most two channels; a provider short of funds opens nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createLiquidityProvider } from '../src/liquidity-provider.js';
import { signGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; };

test('two providers coordinate through their claims: the new node gets two channels, one from each, once', async () => {
  const g = key(9);
  const gw = signGatewayClaim({ node: g.hex, federationId: 'f0'.repeat(32), gatewayUrl: 'https://g.example/gateway/', lightningPubkey: '03' + '99'.repeat(32),
    capacitySats: 0, pegInSats: 50000, atMs: 1, lightningAddr: 'gw.onion:9735' }, (h) => schnorr.sign(h, g.secret));
  const served = new Map([['https://seat-g', { '/gateway-claim': gw }]]);
  const fetcher = async (u) => { for (const [b, docs] of served) for (const [p, d] of Object.entries(docs)) if (u === b + p) return { status: 200, json: async () => d }; return { status: 404, json: async () => null }; };
  const make = (n, free) => {
    const k = key(n); const pending = []; const calls = [];
    const p = createLiquidityProvider({ node: k.hex, sign: (h) => schnorr.sign(h, k.secret), verify, fetcher,
      endpoints: async () => [...served.keys()],
      writeClaim: async (c) => { served.set(`https://seat-${n}`, { '/liquidity-claim': c }); },
      lnd: { channels: async () => ({ ok: true, open: [], pending: pending.map((x) => ({ ...x, initiator: true })) }), funds: async () => ({ ok: true, onchainSats: free }),
        info: async () => ({ ok: true, pubkey: `02${String(n).repeat(64)}`.slice(0, 66), uris: [`02x@p${n}.onion:9735`] }),
        connect: async (o) => { calls.push(['connect', o.host]); return { ok: true }; },
        openTo: async (o) => { calls.push(['open', o.pubkey, o.sats]); pending.push({ peer: o.pubkey, capacitySats: Number(o.sats) }); return { ok: true, fundingTxid: 'ab'.repeat(32) }; } } });
    return { p, calls };
  };
  const a = make(1, 500000), b = make(2, 500000), poor = make(3, 50000);
  await poor.p.tick(); await a.p.tick(); await b.p.tick();      // claims published
  await a.p.tick(); await b.p.tick(); await poor.p.tick();      // now each sees the others
  const opens = [...a.calls, ...b.calls, ...poor.calls].filter((c) => c[0] === 'open');
  assert.equal(opens.length, 2, 'at most two channels to the node');
  assert.deepEqual(opens.map((c) => [c[1], c[2]]), [['03' + '99'.repeat(32), 100000n], ['03' + '99'.repeat(32), 100000n]], 'L = 100,000 sat each');
  assert.equal(poor.calls.filter((c) => c[0] === 'open').length, 0, 'short of L: opens nothing');
  assert.ok(a.calls.some((c) => c[0] === 'connect' && c[1] === 'gw.onion:9735'), 'dialled at the node\'s claimed address');
  await a.p.tick(); await b.p.tick();
  assert.equal([...a.calls, ...b.calls].filter((c) => c[0] === 'open').length, 2, 'once');
});
