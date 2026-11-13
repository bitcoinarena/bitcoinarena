// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r11 (gossip): ONE SEATED GUARDIAN BORROWS ANOTHER'S GATEWAY. A gateway claim is signed by the node that makes it, but the
// gatewayUrl in it is the node's own word: nothing ties it to the node. The watch probes that URL and takes its routing_info
// module_public_key as the claim's, so a guardian that names an honest operator's gateway URL is credited with that gateway's
// availability and its routed volume, and both seats go to one gateway - the third honest gateway is never seated.
// Safe behaviour: one gateway (one URL / one module key) stands for at most one claim; the two seats go to two different gateways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createGatewayWatch } from '../src/gateway-watch.js';
import { signGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const fid = 'f0'.repeat(32);
const keys = [1, 2, 3].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const claimOf = (i, url) => signGatewayClaim({ node: keys[i].hex, federationId: fid, gatewayUrl: url, lightningPubkey: '02' + 'ab'.repeat(32),
  capacitySats: 300000, pegInSats: 60000, atMs: 1, inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000 }, (h) => schnorr.sign(h, keys[i].secret));
const K0 = '02' + '11'.repeat(32), K2 = '03' + '22'.repeat(32);

test('a guardian naming another operator\'s gateway URL is not credited with its volume and does not take its second seat', async () => {
  // node 0: honest gateway at n0; node 2: honest gateway at n2; node 1 (the attacker) signs a claim naming n0's URL
  const claims = { 0: claimOf(0, 'https://n0.example/gateway/'), 1: claimOf(1, 'https://n0.example/gateway/'), 2: claimOf(2, 'https://n2.example/gateway/') };
  const modKey = { 0: K0, 2: K2 };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return { status: 200, json: async () => claims[seat[1]] };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    if (gw) return { status: 200, text: async () => JSON.stringify({ module_public_key: modKey[gw[1]] }) };
    throw new Error(`unexpected ${url}`);
  };
  // the federation's incoming contracts: gateway n0 routed 5,000 sat this epoch, n2 none yet
  let calls = 0;
  const incoming = async () => { calls++; return { ok: true, next: calls, contracts: calls > 1 ? [{ refundPk: K0, amountMsat: '5000000' }] : [] }; };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => keys.map((k) => k.hex), entries: async () => entries,
    tip: async () => 144 * 10 + 5, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, incoming });
  for (let i = 0; i < 3; i++) await w.probe();
  const v = await w.view();
  assert.equal(v.seated.length, 2);
  const urls = v.seated.map((n) => v.gateways[n].url);
  assert.equal(new Set(urls).size, 2, `both gateway seats went to one gateway (${urls.join(', ')}); seated ${v.seated.map((n) => n.slice(0, 8)).join(', ')}`);
  assert.ok(!v.seated.includes(keys[1].hex), 'the node that runs no gateway of its own holds a gateway seat');
  assert.equal(v.gateways[keys[1].hex].volumeSats, '0', 'the borrowed gateway\'s routed volume is credited to the node that named its URL');
});
