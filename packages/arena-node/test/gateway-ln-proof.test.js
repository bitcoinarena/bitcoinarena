// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIGHTNING-KEY PROOF OF A GATEWAY CLAIM (spec §23A.9, kanban #3739): the gateway's Lightning key signs (node key, federation id,
// gateway URL) in LND's signmessage format; the proof is under the claim's node-key signature; it checks only for that node, that
// federation, that URL and that Lightning key. And the cut-over: one block height per network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { signGatewayClaim, checkGatewayClaim, gatewayClaimHash, checkGatewayLnProof, gatewayLnProofMessage, lightningMessageDigest, lightningSigned,
  zbase32Encode, zbase32Decode, gatewayLnProofRequired, GATEWAY_LN_PROOF_FROM } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const recover = (sig64, bit, digest) => secp256k1.recoverPublicKey(Uint8Array.from([bit, ...sig64]), digest, { prehash: false });
// what LND's SignMessage answers: compact signature (header 31 + recovery bit: compressed key), zbase32
const lndSign = (secret, message) => { const r = secp256k1.sign(lightningMessageDigest(message), secret, { prehash: false, format: 'recovered' });
  return zbase32Encode(Uint8Array.from([31 + r[0], ...r.slice(1)])); };
const nodeSecret = new Uint8Array(32).fill(5), node = toHex(schnorr.getPublicKey(nodeSecret));
const otherSecret = new Uint8Array(32).fill(6), other = toHex(schnorr.getPublicKey(otherSecret));
const lnSecret = new Uint8Array(32).fill(9), lnKey = toHex(secp256k1.getPublicKey(lnSecret, true));
const fid = 'f0'.repeat(32), url = 'https://gw.example/gateway/';
const fields = { node, federationId: fid, gatewayUrl: url, lightningPubkey: lnKey, capacitySats: 300000, pegInSats: 55000, atMs: Date.parse('2026-11-25T16:00:00Z'),
  inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000 };

test('zbase32 as LND writes it: the published vector, and a round trip of a 65-byte signature', () => {
  assert.equal(zbase32Encode(Uint8Array.from([0xf0, 0xbf, 0xc7])), '6n9hq');
  assert.deepEqual([...zbase32Decode('6n9hq')], [0xf0, 0xbf, 0xc7]);
  const b = Uint8Array.from({ length: 65 }, (_, i) => (i * 37 + 11) & 255);
  assert.equal(zbase32Encode(b).length, 104);
  assert.deepEqual([...zbase32Decode(zbase32Encode(b))], [...b]);
  assert.equal(zbase32Decode('not-zbase32'), null);
});

test('a good proof checks; a claim without one hashes as before; the proof is under the node signature', () => {
  const plain = signGatewayClaim(fields, (h) => schnorr.sign(h, nodeSecret));
  assert.equal(plain.lightningProof, undefined);
  assert.equal(checkGatewayLnProof(plain, recover).ok, false);
  const lightningProof = lndSign(lnSecret, gatewayLnProofMessage(node, fid, url));
  const proved = signGatewayClaim({ ...fields, lightningProof }, (h) => schnorr.sign(h, nodeSecret));
  assert.equal(proved.lightningProof, lightningProof);
  assert.deepEqual(checkGatewayClaim(proved, verify), { ok: true });
  assert.deepEqual(checkGatewayLnProof(proved, recover), { ok: true });
  assert.notEqual(toHex(gatewayClaimHash(proved)), toHex(gatewayClaimHash(plain)));
  // dropped or swapped after signing: the node signature fails
  const { lightningProof: _dropped, ...stripped } = proved;
  assert.equal(checkGatewayClaim(stripped, verify).ok, false);
  assert.equal(checkGatewayClaim({ ...proved, lightningProof: lndSign(lnSecret, 'other') }, verify).ok, false);
  assert.match(checkGatewayClaim({ ...proved, lightningProof: 'NOT ZBASE32' }, verify).why, /zbase32/);
  // with peg-in outpoints too: both signed, neither read as the other
  const outs = ['f3394aa835525163e306a948d136afb7446977f26a4f347ecbc20faad97988cf:1'];
  const both = signGatewayClaim({ ...fields, lightningProof, pegInOutpoints: outs }, (h) => schnorr.sign(h, nodeSecret));
  assert.deepEqual(checkGatewayClaim(both, verify), { ok: true });
  assert.notEqual(toHex(gatewayClaimHash(both)), toHex(gatewayClaimHash(signGatewayClaim({ ...fields, pegInOutpoints: outs }, (h) => schnorr.sign(h, nodeSecret)))));
});

test('a bad proof fails: another Lightning key, another URL, another federation, a tampered signature', () => {
  const mk = (proof, extra = {}) => signGatewayClaim({ ...fields, ...extra, lightningProof: proof }, (h) => schnorr.sign(h, nodeSecret));
  const wrongKey = lndSign(new Uint8Array(32).fill(10), gatewayLnProofMessage(node, fid, url));
  assert.equal(checkGatewayLnProof(mk(wrongKey), recover).ok, false, 'signed by a key that is not the claim\'s Lightning key');
  assert.equal(checkGatewayLnProof(mk(lndSign(lnSecret, gatewayLnProofMessage(node, fid, 'https://other.example/gateway/'))), recover).ok, false, 'for another URL');
  assert.equal(checkGatewayLnProof(mk(lndSign(lnSecret, gatewayLnProofMessage(node, 'e0'.repeat(32), url))), recover).ok, false, 'for another federation');
  const good = lndSign(lnSecret, gatewayLnProofMessage(node, fid, url));
  const bytes = zbase32Decode(good); bytes[10] ^= 1;
  assert.equal(checkGatewayLnProof(mk(zbase32Encode(bytes)), recover).ok, false, 'tampered');
  assert.equal(lightningSigned({ pubkey: lnKey, message: 'x', signature: '', recover }), false);
});

test('a proof copied into another node\'s claim fails: it names the node it was made for', () => {
  const proof = lndSign(lnSecret, gatewayLnProofMessage(node, fid, url));
  const theft = signGatewayClaim({ ...fields, node: other, lightningProof: proof }, (h) => schnorr.sign(h, otherSecret));
  assert.deepEqual(checkGatewayClaim(theft, verify), { ok: true }, 'the thief\'s own node signature is good');
  assert.equal(checkGatewayLnProof(theft, recover).ok, false, 'but the proof is not for its node key');
});

test('the cut-over: one height per network, the first block of a gateway epoch; before it the proof is not required', () => {
  assert.equal(GATEWAY_LN_PROOF_FROM.testnet4 % 144, 0);
  assert.equal(gatewayLnProofRequired('testnet4', GATEWAY_LN_PROOF_FROM.testnet4 - 1), false);
  assert.equal(gatewayLnProofRequired('testnet4', GATEWAY_LN_PROOF_FROM.testnet4), true);
  assert.equal(gatewayLnProofRequired('mainnet', 0), true);
  assert.equal(gatewayLnProofRequired('nonet', 5), true, 'a network not named: required');
  assert.equal(gatewayLnProofRequired('testnet4', 100, { testnet4: 144 }), false);
});
