// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIQUIDITY PROVIDER SERVICE (§23A.10): two providers and a new node, through each other's claims - the node gets at
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

test('the claim proves the free balance: every coin signed by its address key for this node, once; a spent coin leaves the claim', async () => {
  const { fundsMessage } = await import('../../arena-protocol/src/liquidity.js');
  const k = key(4); let coins = [{ txid: 'aa'.repeat(32), vout: 1, address: 'tb1pone', sats: 400000 }, { txid: 'bb'.repeat(32), vout: 0, address: 'tb1qtwo', sats: 200000 }];
  const signed = []; let claim = null; const state = {};
  const p = createLiquidityProvider({ node: k.hex, sign: (h) => schnorr.sign(h, k.secret), verify, fetcher: async () => ({ status: 404 }), endpoints: async () => [], state,
    writeClaim: async (c) => { claim = c; },
    lnd: { channels: async () => ({ ok: true, open: [], pending: [] }), funds: async () => ({ ok: true, onchainSats: 600000 }),
      info: async () => ({ ok: true, pubkey: '02' + '44'.repeat(32), uris: [] }),
      coins: async () => ({ ok: true, coins }), signWithAddr: async ({ address, message }) => { signed.push([address, message]); return { ok: true, signature: `sig:${address}` }; } } });
  await p.tick();
  assert.deepEqual(claim.funds.map((f) => [f.txid.slice(0, 2), f.vout, f.sats, f.signature]), [['aa', 1, '400000', 'sig:tb1pone'], ['bb', 0, '200000', 'sig:tb1qtwo']], 'largest first');
  assert.deepEqual(signed[0], ['tb1pone', fundsMessage(k.hex, 'aa'.repeat(32), 1)], 'the message names this node and the coin');
  await p.tick();
  assert.equal(signed.length, 2, 'each coin signed once');
  coins = coins.slice(1); await p.tick();
  assert.deepEqual(claim.funds.map((f) => f.txid.slice(0, 2)), ['bb'], 'the spent coin is gone');
  assert.deepEqual(Object.keys(state.fundSigs), ['bb'.repeat(32) + ':0']);
});

test('a provider reached twice (its seat and as a peer) is one provider: never drawn for both of a node\'s channels', async () => {
  const { assignLiquidity } = await import('../../arena-protocol/src/liquidity.js');
  const g = key(9), o = key(5), me = key(6);
  const gw = signGatewayClaim({ node: g.hex, federationId: 'f0'.repeat(32), gatewayUrl: 'https://g.example/gateway/', lightningPubkey: '03' + '99'.repeat(32),
    capacitySats: 0, pegInSats: 50000, atMs: 1, lightningAddr: 'gw.onion:9735' }, (h) => schnorr.sign(h, g.secret));
  const { signLiquidityClaim } = await import('../../arena-protocol/src/liquidity.js');
  const other = (at) => signLiquidityClaim({ node: o.hex, lightningPubkey: '02' + '55'.repeat(32), freeSats: 500000, atMs: at, channels: [] }, (h) => schnorr.sign(h, o.secret));
  const docs = { 'https://seat-o/liquidity-claim': other(1), 'http://peer-o/liquidity-claim': other(2), 'https://seat-g/gateway-claim': gw };
  const fetcher = async (u) => (docs[u] ? { status: 200, json: async () => docs[u] } : { status: 404, json: async () => null });
  const opens = [];
  const p = createLiquidityProvider({ node: me.hex, sign: (h) => schnorr.sign(h, me.secret), verify, fetcher, endpoints: async () => ['https://seat-o', 'http://peer-o', 'https://seat-g'],
    writeClaim: async () => {}, lnd: { channels: async () => ({ ok: true, open: [], pending: [] }), funds: async () => ({ ok: true, onchainSats: 50000 }),
      info: async () => ({ ok: true, pubkey: '02' + '66'.repeat(32), uris: [] }), connect: async () => ({ ok: true }), openTo: async (x) => { opens.push(x); return { ok: true }; } } });
  const r = await p.tick();
  assert.match(r.why, /^2 provider\(s\)/, 'itself and the other one, not three');
  assert.equal(assignLiquidity({ needs: [{ node: g.hex, lightningPubkey: '03' + '99'.repeat(32) }], claims: [other(2)] })[0].open.length, 1);
});

test('a new top-up address on the owner\'s ask: LND makes it, the claim is re-signed with it at once; never beside a running tick', async () => {
  const k = key(7); let claim = null; const state = {}; let n = 0; let inTick = 0, overlap = false;
  const p = createLiquidityProvider({ node: k.hex, sign: (h) => schnorr.sign(h, k.secret), verify, fetcher: async () => ({ status: 404 }), endpoints: async () => [], state,
    writeClaim: async (c) => { claim = c; },
    lnd: { channels: async () => { inTick++; if (inTick > 1) overlap = true; await new Promise((r) => setTimeout(r, 20)); inTick--; return { ok: true, open: [], pending: [] }; },
      funds: async () => ({ ok: true, onchainSats: 600000, address: `tb1paddr${++n}` }), info: async () => ({ ok: true, pubkey: '02' + '77'.repeat(32), uris: [] }) } });
  await p.tick();
  assert.equal(claim.depositAddress, 'tb1paddr1', 'the first address, kept');
  await p.tick(); assert.equal(claim.depositAddress, 'tb1paddr1', 'a tick keeps it');
  const [, r] = await Promise.all([p.tick(), p.newAddress()]);
  assert.equal(r.ok, true); assert.equal(claim.depositAddress, r.address, 'the claim names the new one');
  assert.notEqual(r.address, 'tb1paddr1'); assert.equal(state.depositAddress, r.address, 'kept for the next ticks');
  assert.equal(overlap, false, 'one tick at a time');
});
