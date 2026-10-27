// A seat's own advertisement check names the games it loaded (kanban #685, measured 2026-10-27: the seats loaded Up/Down v24 and never
// announced it, so no v24 round could seat them): a new game is added beside the guardians, nothing is removed, the list stays sorted,
// and nothing new is no update at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvertAfter } from '../src/add-bond-wallet.js';
import { encodeAdvert, decodeAdvert } from '../../arena-protocol/src/advert.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const g = { federationId: b32(0x33), guardianKey: Uint8Array.from([2, ...b32(0x44)]) };
const advert = { nodePubkey: b32(1), operatorId: 'op', protocolVersions: [1], hostedGames: [b32(0x10), b32(0x30)], roles: ['game', 'verify'],
  endpoint: 'wss://example.invalid/n1', region: 'eu', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [g], timestamp: 1n, guardianCapable: false, guardianEndpoint: '' };

test('a game loaded and not announced: added, sorted, the others and the guardians kept', () => {
  const r = ownAdvertAfter(advert, { guardianOf: [g], hostedGames: [b32(0x20), b32(0x10)], nowMs: 5 });
  assert.deepEqual(r.addedGames, [toHex(b32(0x20))]);
  assert.deepEqual(r.advert.hostedGames.map(toHex), [b32(0x10), b32(0x20), b32(0x30)].map(toHex));
  assert.equal(r.before, r.after, 'guardian_of unchanged');
  assert.deepEqual(decodeAdvert(encodeAdvert(r.advert)).hostedGames.map(toHex), r.advert.hostedGames.map(toHex), 'a valid advertisement');
});

test('nothing new: no update; a game the advertisement names and the seat no longer loads stays', () => {
  assert.deepEqual(ownAdvertAfter(advert, { guardianOf: [g], hostedGames: [b32(0x10)] }), { same: true });
  assert.deepEqual(ownAdvertAfter(advert, { guardianOf: [g], hostedGames: [] }), { same: true });
  const both = ownAdvertAfter(advert, { guardianOf: [], hostedGames: [] });
  assert.equal(both.same, undefined, 'a changed guardian_of is still an update');
});
