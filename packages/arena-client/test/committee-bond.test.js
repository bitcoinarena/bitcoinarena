// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SESSION PROVES A SEAT ON THE ROUND'S COMMITTEE (measured 2026-10-16 07:51Z on the hotfix page: "no proven endpoint:
// the advertisement is for 2fca1090..., which is not on this round's committee"). daily.json names one bond - seat 1's - and a
// committee is 7 of 14 seats, so about half the rounds could not be joined. committeeBond keeps the named bond when its node is on
// the committee, else takes the first of the round's seats whose own /bond names a committee member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { committeeBond, committeeBonds, bondProvider } from '../src/join.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (nodePubkey) => ({
  nodePubkey, operatorId: 'somebody', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify'],
  endpoint: 'wss://seat.example', region: 'eu-west', capacityClass: 2, softwareHash: b32(3), settlementCapabilities: 0,
  lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(4),
  guardianOf: [], timestamp: 1788700000000n,
});
const bondOf = (key) => ({ hex: toHex(bondTransaction(advertFor(key), { signature: schnorr.sign(advertId(advertFor(key)), schnorr.utils.randomSecretKey()) })), merkle: [], pos: 0 });
const SEAT1 = b32(0x11), SEAT2 = b32(0x22), SEAT3 = b32(0x33);
const served = { 'https://s1.example/bond': bondOf(SEAT1), 'https://s2.example/bond': bondOf(SEAT2), 'https://s3.example/bond': bondOf(SEAT3) };
const fetcher = async (u) => (served[u] ? { ok: true, json: async () => served[u] } : { ok: false, status: 404, json: async () => ({}) });
const nodes = ['https://s1.example', 'https://s2.example/', 'https://s3.example'];

test('the named bond when its seat is on the committee', async () => {
  assert.equal(await committeeBond({ bond: 'https://s1.example/bond', nodes, committee: [SEAT1, SEAT3], fetcher }), 'https://s1.example/bond');
});

test('a seat of the committee when the named one is not - the live case: seat 1 off the committee', async () => {
  assert.equal(await committeeBond({ bond: 'https://s1.example/bond', nodes, committee: [SEAT2, b32(0x44)], fetcher }), 'https://s2.example/bond');
});

test('no seat answers for the committee: the named bond, as before (its refusal names why)', async () => {
  assert.equal(await committeeBond({ bond: 'https://s1.example/bond', nodes, committee: [b32(0x55)], fetcher }), 'https://s1.example/bond');
  const down = async () => { throw new Error('offline'); };
  assert.equal(await committeeBond({ bond: 'https://s1.example/bond', nodes, committee: [SEAT2], fetcher: down }), 'https://s1.example/bond');
});

// THE BOND ALREADY READ IS NOT READ AGAIN, AND ONE SEAT IS NOT THE ONLY ONE (measured 2026-10-16 11:20:47Z on preview
// UI 151 after Unity's PLAY: the entry made, then "no bond: no provider proved that bond into the chain (provider 0: no answer in
// 10000 ms)" - one provider, reading again the /bond the committee search had just read)
test('every committee seat is found, each with the /bond it answered, in the candidates\' order', async () => {
  const found = await committeeBonds({ bond: 'https://s1.example/bond', nodes, committee: [SEAT3, SEAT2], fetcher });
  assert.deepEqual(found.map((f) => f.where), ['https://s2.example/bond', 'https://s3.example/bond']);
  assert.equal(found[0].body.hex, served['https://s2.example/bond'].hex);
});
test('a bond provider handed the answer proves from it, with no second read', async () => {
  const never = async () => { throw new Error('read again'); };
  const p = bondProvider('https://s2.example/bond', { fetcher: never, body: served['https://s2.example/bond'] });
  const got = await p(null, {});
  assert.equal(toHex(got.transaction), served['https://s2.example/bond'].hex);
  assert.deepEqual([got.branch.length, got.position], [0, 0]);
});
test('two seats behind one public host are two bond sources, as two header sources are', () => {
  const a = bondProvider('https://tn4.example/guardian-2/bond', { body: served['https://s2.example/bond'] });
  const b = bondProvider('https://tn4.example/guardian-5/bond', { body: served['https://s3.example/bond'] });
  assert.notEqual(a.tag, b.tag);
  assert.deepEqual([a.tag, b.tag], ['https://tn4.example/guardian-2', 'https://tn4.example/guardian-5']);
});
