// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GATEWAY CLAIM'S PEG-IN OUTPOINTS (spec §23A.3a "What counts as the peg-in", kanban #559/#543): signed with the rest when the claim names
// any; a claim that names none hashes as before (the claims already out keep their signatures); a changed list fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewayClaim, checkGatewayClaim, gatewayClaimHash, pegInOutpointsOf, pegInItem, pegInAgeStands, pegInItemsWithHeights } from '../src/gateway-claim.js';
import { PEG_IN_MAX_AGE, pegInMaxAgeOf } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const secret = new Uint8Array(32).fill(5), node = toHex(schnorr.getPublicKey(secret));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fields = { node, federationId: 'f0'.repeat(32), gatewayUrl: 'https://gw.example/gateway/', lightningPubkey: '02' + 'ab'.repeat(32), capacitySats: 300000,
  pegInSats: 55000, atMs: Date.parse('2026-10-20T16:00:00Z'), inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000 };
const A = 'f3394aa835525163e306a948d136afb7446977f26a4f347ecbc20faad97988cf:1', B = 'c35cf68fc9a922bf5d922b2c1cdcdf0d10b068a6ff7496940caec67780ae2266:1';

test('no outpoints: the same hash as a claim before them; outpoints signed, sorted and once each; a changed list fails', () => {
  const plain = signGatewayClaim(fields, (h) => schnorr.sign(h, secret));
  assert.equal(plain.pegInOutpoints, undefined);
  assert.deepEqual(checkGatewayClaim(plain, verify), { ok: true });
  const withOuts = signGatewayClaim({ ...fields, pegInOutpoints: [B, A.toUpperCase(), A] }, (h) => schnorr.sign(h, secret));
  assert.deepEqual(withOuts.pegInOutpoints, [B, A].map((x) => x.toLowerCase()).sort());
  assert.deepEqual(checkGatewayClaim(withOuts, verify), { ok: true });
  assert.notEqual(toHex(gatewayClaimHash(withOuts)), toHex(gatewayClaimHash(plain)), 'the outpoints are under the signature');
  assert.equal(checkGatewayClaim({ ...withOuts, pegInOutpoints: [A] }, verify).ok, false, 'one outpoint dropped: the signature fails');
  assert.match(checkGatewayClaim({ ...withOuts, pegInOutpoints: ['nope'] }, verify).why, /txid:vout/);
});

// THE AGE OF A PEG-IN (§23A.3a, kanban #999/#1026): each item may carry its height, signed as it stands
const sign = (over) => signGatewayClaim({ ...fields, ...over }, (h) => schnorr.sign(h, secret));
const AT = `${A}@158000`, BT = `${B}@158100`;

test('a claim naming no heights hashes as the code before them did: two hashes from that code, byte for byte', () => {
  const c = { node: '11'.repeat(32), federationId: 'f0'.repeat(32), gatewayUrl: 'https://gw.example/gateway/', lightningPubkey: '02' + 'ab'.repeat(32), capacitySats: '300000', pegInSats: '55000',
    atMs: String(Date.parse('2026-10-20T16:00:00Z')), inboundSats: '150000', outboundSats: '150000', outsideInboundSats: '150000', lightningAddr: '' };
  assert.equal(toHex(gatewayClaimHash(c)), '30d207cb4dacfaef436c6e54fe532a563e086a96b6878e39e52d1a162f8b01e9');
  assert.equal(toHex(gatewayClaimHash({ ...c, pegInOutpoints: [A, B] })), '157a32894b458cea455bf5a73d27a343692f7df107f1124306b1b7c472e59092');
});

test('heights are signed with the claim: a changed height fails, one outpoint twice is refused, a malformed height is too', () => {
  const c = sign({ pegInOutpoints: [BT, AT] });
  assert.deepEqual(c.pegInOutpoints, [AT, BT].sort());
  assert.deepEqual(checkGatewayClaim(c, verify), { ok: true });
  assert.notEqual(toHex(gatewayClaimHash(c)), toHex(gatewayClaimHash(sign({ pegInOutpoints: [A, B] }))));
  assert.equal(checkGatewayClaim({ ...c, pegInOutpoints: c.pegInOutpoints.map((x) => x.replace('158000', '158001')) }, verify).ok, false);
  assert.match(checkGatewayClaim(sign({ pegInOutpoints: [AT, `${A}@158001`] }), verify).why, /each outpoint once/);
  assert.match(checkGatewayClaim({ ...c, pegInOutpoints: [`${A}@x`, BT] }, verify).why, /txid:vout@height/);
  assert.deepEqual(pegInOutpointsOf({ pegInOutpoints: [`${A}@`, AT] }), [AT]);
  assert.deepEqual([pegInItem(AT), pegInItem(A)], [{ outpoint: A, height: 158000 }, { outpoint: A, height: null }]);
});

test('peg_in_max_age: at most that old at the epoch\'s first height, a peg-in younger than it stands, no height never does', () => {
  assert.deepEqual({ ...PEG_IN_MAX_AGE }, { mainnet: 4320, testnet4: 1008, regtest: 100, devnet: 100 });
  assert.deepEqual([pegInMaxAgeOf('testnet'), pegInMaxAgeOf('testnet4'), pegInMaxAgeOf('nowhere'), pegInMaxAgeOf(null)], [1008, 1008, null, null]);
  const stands = (height) => pegInAgeStands({ height, epochStart: 1000, maxAge: 100 });
  assert.deepEqual([stands(900), stands(899), stands(1050), stands(null)], [true, false, true, false]);
  assert.equal(pegInAgeStands({ height: 900, epochStart: 1000, maxAge: null }), false);
});

test('a gateway names heights only on a network with a rules epoch: testnet4 stays bare, so a seat of an older release keeps its claim', async () => {
  const bare = await pegInItemsWithHeights({ items: [A, AT], network: 'testnet4', tip: 158613, confirmationsOf: async () => { throw new Error('not asked'); } });
  assert.deepEqual(bare, [A, A], 'bare, even one given with a height');
  assert.deepEqual(await pegInItemsWithHeights({ items: [A], network: 'mainnet', tip: 1, confirmationsOf: null }), [A], 'mainnet names no epoch yet');
  const named = await pegInItemsWithHeights({ items: [A, B, BT], network: 'regtest', tip: 500, confirmationsOf: async (o) => (o === A ? 11 : null) });
  assert.deepEqual(named, [`${A}@490`, B, BT], 'tip - confirmations + 1; one it cannot read stays bare; one given keeps its height');
  assert.deepEqual(await pegInItemsWithHeights({ items: [A], network: 'regtest', tip: 500, confirmationsOf: async () => { throw new Error('rpc down'); } }), [A]);
});
