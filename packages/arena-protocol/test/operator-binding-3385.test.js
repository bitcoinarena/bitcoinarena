// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3385 (closes #3146): an advert's operatorId counts only with the operator key's signature over (node key, operatorId, network);
// without it the node is its own operator. A signed multi-node operator is still one ticket; a stranger naming its key is not grouped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodeAdvert, decodeAdvert } from '../src/advert.js';
import { operatorBindingId, boundOperatorOf } from '../src/operator-binding.js';
import { drawGuardians } from '../src/guardian-founding.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const OP_SECRET = b32(0x33), OP = toHex(schnorr.getPublicKey(OP_SECRET));
const nodeSecret = (n) => b32(0x10 + n), nodeKey = (n) => schnorr.getPublicKey(nodeSecret(n));
const bind = (n, network = 'testnet4', secret = OP_SECRET) => schnorr.sign(operatorBindingId({ nodePubkey: nodeKey(n), operatorId: OP, network }), secret);

const advert = (extra = {}) => ({
  nodePubkey: nodeKey(1), operatorId: OP, protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement', 'verify'],
  endpoint: 'wss://seat.example.com/1', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  guardianCapable: true, guardianEndpoint: 'wss://seat.example.com/1/guardian', ...extra });

test('#3385 the binding signature rides in the advert after the timestamp, with every optional tail; an advert without it keeps its bytes', () => {
  const sig = bind(1);
  for (const tail of [{}, { serving: false }, { declares: { bondMinSats: 1n, proposalDepositSats: 2n } }, { emergencyPubkey: b32(9) },
    { declares: { bondMinSats: 1n, proposalDepositSats: 2n }, emergencyPubkey: b32(9), serving: false }]) {
    const a = advert({ ...tail, operatorSig: sig });
    assert.deepEqual(decodeAdvert(encodeAdvert(a)), a);
    const plain = advert(tail);
    assert.deepEqual(decodeAdvert(encodeAdvert(plain)), plain);
    assert.equal(encodeAdvert(a).length, encodeAdvert(plain).length + 65);
  }
});

test('#3385 bound only with the operator key\'s signature for this node and this network; else the node is its own operator', () => {
  const node = toHex(nodeKey(1));
  assert.equal(boundOperatorOf(advert({ operatorSig: bind(1) }), 'testnet4', verify), OP);
  assert.equal(boundOperatorOf(advert(), 'testnet4', verify), node, 'no signature');
  assert.equal(boundOperatorOf(advert({ operatorSig: bind(2) }), 'testnet4', verify), node, 'signed for another node');
  assert.equal(boundOperatorOf(advert({ operatorSig: bind(1, 'regtest') }), 'testnet4', verify), node, 'signed for another network');
  assert.equal(boundOperatorOf(advert({ operatorSig: bind(1, 'testnet4', b32(0x44)) }), 'testnet4', verify), node, 'signed by another key');
  assert.equal(boundOperatorOf(advert({ operatorId: 'op3', operatorSig: bind(1) }), 'testnet4', verify), node, 'an id that is no key');
});

// census entries as deriveCensus hands them: `operator` is the bound operator
const entry = (n, { signed = true, bond = 1000000n, txid = b32(0x40 + n), op = OP } = {}) => {
  const a = { nodePubkey: nodeKey(n), operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, guardianOf: [], ...(signed ? { operatorSig: bind(n) } : {}) };
  return { pubkey: nodeKey(n), txid, vout: 0, bondSats: bond, advert: a, operator: boundOperatorOf(a, 'testnet4', verify) };
};
const others = Array.from({ length: 9 }, (_, i) => { const n = 20 + i; const a = { nodePubkey: nodeKey(n), operatorId: '', guardianCapable: true, guardianEndpoint: `wss://g${n}`, guardianOf: [] };
  return { pubkey: nodeKey(n), txid: b32(0x60 + i), vout: 0, bondSats: 1000000n, advert: a, operator: toHex(nodeKey(n)) }; });

test('#3385 an honest operator\'s two signed nodes are one ticket with their summed bond', () => {
  const d = drawGuardians({ entries: [entry(1), entry(2), ...others], seed: b32(7), height: 160000, nominal: 7, bondMinGuardian: 50000n });
  assert.equal(d.ok, true, d.why);
  assert.equal(d.eligible, 10, 'nine others and the operator once');
  const seated = [...d.drawn, ...d.alternates].map((e) => toHex(e.pubkey));
  assert.ok(!(seated.includes(toHex(nodeKey(1))) && seated.includes(toHex(nodeKey(2)))), 'never both of one operator\'s nodes');
});

test('#3385 (#3146) a stranger naming the operator\'s key without its signature is its own operator: never on the operator\'s ticket', () => {
  for (let s = 1; s < 60; s++) {
    const honest = drawGuardians({ entries: [entry(1), ...others], seed: b32(s), height: 160000, nominal: 7, bondMinGuardian: 50000n });
    const squat = entry(9, { signed: false, bond: 50000n, txid: b32(0) });
    assert.equal(squat.operator, toHex(nodeKey(9)));
    const d = drawGuardians({ entries: [entry(1), squat, ...others], seed: b32(s), height: 160000, nominal: 7, bondMinGuardian: 50000n });
    assert.equal(d.ok, true, d.why);
    assert.equal(d.eligible, honest.eligible + 1, 'the stranger is a ticket of its own');
    for (const e of [...d.drawn, ...d.alternates]) if (e.operator === OP) assert.equal(toHex(e.pubkey), toHex(nodeKey(1)), 'only the operator\'s own node stands for it');
  }
});
