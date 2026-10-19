// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROVEN FREE BALANCE (§23A.10, kanban #494): a provider's coins, each signed by its address key (Bitcoin signmessage, as LND's
// SignMessageWithAddr makes it) for this provider's node; a guardian counts a coin only when the signature is good and its own chain
// shows it unspent paying that address, at the chain's amount. The claim's freeSats alone weighs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { messageCurve } from '../../arena-node/src/curve.js';
import { signLiquidityClaim, checkLiquidityClaim, fundsMessage, signedMessageDigest, addressSigned, provenFreeSats } from '../src/liquidity.js';
import { liquiditySeatingFrom } from '../src/liquidity-seating.js';
import { taprootAddress, addressScript } from '../src/address.js';
import { bech32Encode, convertBits } from '../src/bech32.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b64 = (b) => Buffer.from(b).toString('base64');
// Bitcoin's compact signature: header 27 + 4 (compressed) + recovery bit, then r and s
const signMsg = (secret, message) => { const r = secp256k1.sign(signedMessageDigest(message), secret, { prehash: false, format: 'recovered' }); return b64([31 + r[0], ...r.slice(1)]); };
const keyOf = (n) => { const secret = new Uint8Array(32).fill(n); const pub = secp256k1.getPublicKey(secret, true);
  return { secret, p2wpkh: bech32Encode('tb', [0, ...convertBits(messageCurve.hash160(pub), 8, 5, true)]), p2tr: taprootAddress(messageCurve.taprootOutputKey(pub)) }; };
const provider = (n) => { const secret = new Uint8Array(32).fill(0x60 + n); return { secret, node: toHex(schnorr.getPublicKey(secret)) }; };

test('a coin\'s signature: the address key, for this node; another node, address or key is refused', () => {
  const k = keyOf(5), P = provider(1), txid = 'ab'.repeat(32);
  for (const address of [k.p2wpkh, k.p2tr]) {
    const message = fundsMessage(P.node, txid, 1);
    const signature = signMsg(k.secret, message);
    assert.equal(addressSigned({ address, message, signature, curve: messageCurve }), true, address.slice(0, 6));
    assert.equal(addressSigned({ address, message: fundsMessage(provider(2).node, txid, 1), signature, curve: messageCurve }), false, 'for another node');
    assert.equal(addressSigned({ address: address === k.p2tr ? keyOf(6).p2tr : keyOf(6).p2wpkh, message, signature, curve: messageCurve }), false, 'another address');
    assert.equal(addressSigned({ address, message, signature: signMsg(keyOf(6).secret, message), curve: messageCurve }), false, 'another key');
    assert.equal(addressSigned({ address, message, signature: 'not base64!', curve: messageCurve }), false);
  }
});

test('the proven balance: signed and unspent at the chain\'s amount; spent, unsigned, foreign or doubled coins count nothing', async () => {
  const P = provider(1), k = keyOf(5), j = keyOf(7);
  const coin = (txid, vout, key, address, sats, by = P.node) => ({ txid, vout, address, sats, signature: signMsg(key.secret, fundsMessage(by, txid, vout)) });
  const funds = [
    coin('01'.repeat(32), 0, k, k.p2tr, 400000),          // unspent: the chain says 410,000
    coin('02'.repeat(32), 1, j, j.p2wpkh, 300000),        // unspent
    coin('03'.repeat(32), 0, k, k.p2tr, 900000),          // spent
    coin('04'.repeat(32), 0, k, k.p2tr, 900000, provider(2).node),   // signed for another provider
    coin('05'.repeat(32), 0, k, k.p2tr, 900000),          // the chain's output pays another address
  ];
  funds.push({ ...funds[1] });                              // listed twice
  const chain = new Map([
    ['01'.repeat(32) + ':0', { sats: 410000n, script: toHex(addressScript(k.p2tr)) }],
    ['02'.repeat(32) + ':1', { sats: 300000n, script: toHex(addressScript(j.p2wpkh)) }],
    ['04'.repeat(32) + ':0', { sats: 900000n, script: toHex(addressScript(k.p2tr)) }],
    ['05'.repeat(32) + ':0', { sats: 900000n, script: toHex(addressScript(j.p2tr)) }],
  ]);
  const claim = signLiquidityClaim({ node: P.node, lightningPubkey: '02' + '11'.repeat(32), freeSats: 9999999, atMs: 1, channels: [], funds }, (h) => schnorr.sign(h, P.secret));
  assert.equal(checkLiquidityClaim(claim, verify).ok, true);
  assert.match(checkLiquidityClaim({ ...claim, funds: claim.funds.slice(1) }, verify).why, /not signed by its node key/, 'the coins are under the claim\'s signature');
  const proven = await provenFreeSats({ claim, curve: messageCurve, txOut: async (t, v) => chain.get(`${t}:${v}`) || null });
  assert.equal(proven, 710000n, '410,000 + 300,000: the chain\'s amounts, not the claimed 9,999,999');
  // the seating weighs the proven balance: 710,000 free + a 100,000 channel -> 800,000; proven 399,999 + the 100,000 given, below the deposit -> out
  const fedKey = '03' + '99'.repeat(32);
  const withCh = { ...claim, channels: [{ peer: fedKey, capacitySats: '100000' }] };
  assert.deepEqual(liquiditySeatingFrom({ claims: [withCh], federationLnKeys: [fedKey], proven: new Map([[P.node, proven]]) }).map((p) => p.weight), [800000n]);
  assert.deepEqual(liquiditySeatingFrom({ claims: [withCh], federationLnKeys: [fedKey], proven: new Map([[P.node, 399999n]]) }), [], 'proven below 500,000: no share');
  assert.deepEqual(liquiditySeatingFrom({ claims: [withCh], federationLnKeys: [fedKey], proven: new Map() }), [], 'nothing proven: no share');
});
