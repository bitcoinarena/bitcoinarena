// THE SESSION PROVES A SEAT ON THE ROUND'S COMMITTEE (kanban #376, measured 2026-10-16 07:51Z on the hotfix page: "no proven endpoint:
// the advertisement is for 2fca1090..., which is not on this round's committee"). daily.json names one bond - seat 1's - and a
// committee is 7 of 14 seats, so about half the rounds could not be joined. committeeBond keeps the named bond when its node is on
// the committee, else takes the first of the round's seats whose own /bond names a committee member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { committeeBond } from '../src/join.js';
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
