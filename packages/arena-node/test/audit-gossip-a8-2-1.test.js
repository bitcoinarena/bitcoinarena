// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit gossip r2-1 (kanban #3739): GAP IN THE #2422 FIX - FIRST COME HOLDS THE GATEWAY. #2422 made a gateway (its URL, its module key)
// "held by the first node this guardian saw name it". Nothing tied the gateway to the node that signed the claim, so which claim is
// "first" was only the order the probe walks the seated guardians in (the federation record's guardian order) - or who named it first
// in time. A seated guardian that comes before the honest operator in that order and names the honest gateway's URL owned it: the
// honest operator's own claim was probed as down, it lost its gateway seat and its routed volume, and the borrower took both.
// Safe behaviour (owner ruling 2026-11-25, the Lightning-key proof): the operator whose claim carries its gateway's Lightning-key proof
// keeps its seat and its volume whatever the order of the seated guardians; a claim that cannot prove the gateway gets nothing of it.
// Before the cut-over claims without a proof keep the first-come rule between them; from it they count for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createGatewayWatch } from '../src/gateway-watch.js';
import { signGatewayClaim, gatewayLnProofMessage, lightningMessageDigest, zbase32Encode } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const fid = 'f0'.repeat(32);
const keys = [1, 2, 3].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
// each gateway's LND node key; node 1 (the attacker) runs none
const ln = { 0: new Uint8Array(32).fill(40), 2: new Uint8Array(32).fill(42) };
const lnKey = (i) => toHex(secp256k1.getPublicKey(ln[i], true));
const lndSign = (secret, message) => { const r = secp256k1.sign(lightningMessageDigest(message), secret, { prehash: false, format: 'recovered' });
  return zbase32Encode(Uint8Array.from([31 + r[0], ...r.slice(1)])); };
const proofBy = (lnIndex, nodeIndex, url) => lndSign(ln[lnIndex], gatewayLnProofMessage(keys[nodeIndex].hex, fid, url));
const claimOf = (i, url, { lightningPubkey, lightningProof } = {}) => signGatewayClaim({ node: keys[i].hex, federationId: fid, gatewayUrl: url, lightningPubkey,
  capacitySats: 300000, pegInSats: 60000, atMs: 1, inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000, ...(lightningProof ? { lightningProof } : {}) },
(h) => schnorr.sign(h, keys[i].secret));
const N0 = 'https://n0.example/gateway/', N2 = 'https://n2.example/gateway/';
const K0 = '02' + '11'.repeat(32), K2 = '03' + '22'.repeat(32);
const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));

// n0 routes 5,000 sat once, seen by the second probe (the first takes the stream's index); `answers`: routing_info per gateway index
function run({ claims, order, answers = { 0: { module_public_key: K0, lightning_public_key: lnKey(0) }, 2: { module_public_key: K2, lightning_public_key: lnKey(2) } }, lnProofFrom, tipAt = 144 * 10 + 5 }) {
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    if (gw) return { status: 200, text: async () => JSON.stringify(answers[gw[1]] || null) };
    throw new Error(`unexpected ${url}`);
  };
  let calls = 0;
  const incoming = async () => { calls++; return { ok: true, next: calls, contracts: calls === 2 ? [{ refundPk: K0, amountMsat: '5000000' }] : [] }; };
  return createGatewayWatch({ federationId: async () => fid, seated: async () => order.map((i) => keys[i].hex), entries: async () => entries,
    tip: async () => tipAt, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, incoming, ...(lnProofFrom ? { lnProofFrom } : {}) });
}
const probed = async (w) => { for (let i = 0; i < 3; i++) await w.probe(); return w.view(); };
const honest0 = () => claimOf(0, N0, { lightningPubkey: lnKey(0), lightningProof: proofBy(0, 0, N0) });
const honest2 = () => claimOf(2, N2, { lightningPubkey: lnKey(2), lightningProof: proofBy(2, 2, N2) });

test('a guardian listed before the honest operator and naming its gateway URL does not take that operator\'s gateway seat or volume', async () => {
  // node 0: honest gateway at n0, its claim proved by n0's Lightning key; node 2: the same at n2; node 1 (the attacker) runs no gateway
  // and signs a claim naming n0's URL and Lightning key - it cannot make n0's LND sign for its node key
  const claims = { 0: honest0(), 1: claimOf(1, N0, { lightningPubkey: lnKey(0) }), 2: honest2() };
  // THE ONLY CHANGE AGAINST wf1489-r11-gossip-1: the record lists the attacker (node 1) before the honest operator (node 0)
  const v = await probed(run({ claims, order: [1, 0, 2] }));
  assert.equal(v.seated.length, 2);
  assert.ok(v.seated.includes(keys[0].hex), `the operator that runs gateway n0 lost its seat; seated ${v.seated.map((n) => n.slice(0, 8)).join(', ')} (${JSON.stringify(v.ineligible || [])})`);
  assert.ok(!v.seated.includes(keys[1].hex), 'the node that runs no gateway of its own holds a gateway seat');
  assert.equal(v.gateways[keys[1].hex].volumeSats, '0', 'gateway n0\'s routed volume is credited to the node that named its URL first');
  assert.equal(v.gateways[keys[0].hex].volumeSats, '5000', 'the operator of gateway n0 is credited nothing of what it routed');
});

test('an attacker that copies the operator\'s proof into its own claim is refused: the proof names the operator\'s node key', async () => {
  const claims = { 0: honest0(), 1: claimOf(1, N0, { lightningPubkey: lnKey(0), lightningProof: proofBy(0, 0, N0) }), 2: honest2() };
  const v = await probed(run({ claims, order: [1, 0, 2] }));
  assert.deepEqual([...v.seated].sort(), [keys[0].hex, keys[2].hex].sort());
  assert.equal(v.gateways[keys[1].hex].volumeSats, '0');
  assert.equal(v.gateways[keys[0].hex].volumeSats, '5000');
  // after the cut-over the copied proof counts for nothing either: the attacker does not stand at all
  const after = await probed(run({ claims, order: [1, 0, 2], lnProofFrom: { testnet4: 0 } }));
  assert.equal(after.gateways[keys[1].hex], undefined, 'a claim whose proof is not its own does not stand after the cut-over');
  assert.deepEqual([...after.seated].sort(), [keys[0].hex, keys[2].hex].sort());
});

test('an attacker at its own URL whose routing_info answers the operator\'s module key is refused: it cannot prove that gateway', async () => {
  // node 1 names its own URL (n1), forwarded to n0: same module key, same Lightning key; listed first
  const claims = { 0: honest0(), 1: claimOf(1, 'https://n1.example/gateway/', { lightningPubkey: lnKey(0) }), 2: honest2() };
  const fwd = { module_public_key: K0, lightning_public_key: lnKey(0) };
  const v = await probed(run({ claims, order: [1, 0, 2], answers: { 0: fwd, 1: fwd, 2: { module_public_key: K2, lightning_public_key: lnKey(2) } } }));
  assert.deepEqual([...v.seated].sort(), [keys[0].hex, keys[2].hex].sort());
  assert.equal(v.gateways[keys[1].hex].volumeSats, '0');
  assert.equal(v.gateways[keys[0].hex].volumeSats, '5000');
});

test('a gateway whose routing_info answers another Lightning key than the claim\'s is refused, proof or not', async () => {
  // node 0's proof is good, but the gateway at its URL answers n2's Lightning key: it is not the claim's gateway
  const claims = { 0: honest0(), 2: honest2() };
  const v = await probed(run({ claims, order: [0, 2], answers: { 0: { module_public_key: K0, lightning_public_key: lnKey(2) }, 2: { module_public_key: K2, lightning_public_key: lnKey(2) } } }));
  assert.equal(v.gateways[keys[0].hex].availabilityPct, 0, 'probed as up although its gateway answers another Lightning key');
  assert.ok(!v.seated.includes(keys[0].hex) || (v.belowMinimums || []).includes(keys[0].hex));
  assert.ok((v.ineligible || []).some((x) => x.node === keys[0].hex), JSON.stringify(v.ineligible));
  // and a proving claim whose gateway names no Lightning key is not bound to it either
  const none = await probed(run({ claims, order: [0, 2], answers: { 0: { module_public_key: K0 }, 2: { module_public_key: K2, lightning_public_key: lnKey(2) } } }));
  assert.equal(none.gateways[keys[0].hex].availabilityPct, 0);
});

test('two claims naming one gateway, neither proving it: first come during the grace period, neither counts after the cut-over', async () => {
  // nodes 0 and 1 both name n0 with no proof; node 2 proves n2
  const claims = { 0: claimOf(0, N0, { lightningPubkey: lnKey(0) }), 1: claimOf(1, N0, { lightningPubkey: lnKey(0) }), 2: honest2() };
  const grace = await probed(run({ claims, order: [1, 0, 2] }));
  assert.ok(grace.seated.includes(keys[1].hex), 'during the grace period the first claim read holds the unproved gateway (#2422)');
  assert.ok(!grace.seated.includes(keys[0].hex));
  assert.equal(grace.gateways[keys[0].hex].volumeSats, '0');
  const after = await probed(run({ claims, order: [1, 0, 2], lnProofFrom: { testnet4: 0 } }));
  assert.deepEqual(after.seated, [keys[2].hex], 'after the cut-over a claim without a proof counts for nothing');
  assert.equal(after.gateways[keys[0].hex], undefined);
  assert.equal(after.gateways[keys[1].hex], undefined);
  // the cut-over is judged per epoch: one epoch before it, still the grace
  const before = await probed(run({ claims, order: [1, 0, 2], lnProofFrom: { testnet4: 144 * 11 } }));
  assert.ok(before.seated.includes(keys[1].hex));
});

test('a proving claim takes the gateway from a holder that proved nothing in an earlier probe', async () => {
  // the operator's proof arrives only after the attacker held n0 for a probe (e.g. its custody agent signed the proof late)
  const claims = { 0: claimOf(0, N0, { lightningPubkey: lnKey(0) }), 1: claimOf(1, N0, { lightningPubkey: lnKey(0) }), 2: honest2() };
  const w = run({ claims, order: [1, 0, 2] });
  await w.probe();
  claims[0] = honest0();
  for (let i = 0; i < 25; i++) await w.probe();   // 25 of 26 probes up: available 96 %
  const v = await w.view();
  assert.ok(v.seated.includes(keys[0].hex), JSON.stringify(v.ineligible));
  assert.ok(!v.seated.includes(keys[1].hex));
  assert.equal(v.gateways[keys[1].hex].volumeSats, '0');
  assert.equal(v.gateways[keys[0].hex].volumeSats, '5000');
});
