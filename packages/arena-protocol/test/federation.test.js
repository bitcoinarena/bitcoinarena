// A FEDERATION IS A ROUND'S CUSTODIAN ONLY IF ITS THRESHOLD OF GUARDIANS ARE
// BONDED CENSUS NODES (§23.6, v4.6.2, P3) - the census the client derived, the
// advertisements the bonds committed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAdvert, decodeAdvert } from '../src/advert.js';
import { federationIsBonded } from '../src/federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (n) => Uint8Array.from([0x02, ...b32(n)]);
const FED = b32(0xfe);
const GUARDIANS = [key(1), key(2), key(3), key(4)];
const entry = (n, guardianOf, bondSats = 100000n) => ({
  pubkey: b32(0x40 + n), bondSats, advert: { nodePubkey: b32(0x40 + n), guardianOf },
});
const ask = (census, over = {}) => federationIsBonded({
  federationId: FED, guardianKeys: GUARDIANS, threshold: 3, census, bondMinSats: 50000n, ...over,
});

test('an advertisement carries guardian_of[] in its signed bytes, sorted', () => {
  const a = {
    nodePubkey: b32(1), operatorId: 'op', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['settlement'],
    endpoint: 'ws://n', region: 'eu', capacityClass: 1, softwareHash: b32(2),
    settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: b32(0), bondVout: 0,
    bondScriptTemplateVersion: 1, payoutPubkey: b32(3),
    guardianOf: [{ federationId: FED, guardianKey: key(1) }, { federationId: FED, guardianKey: key(2) }],
    timestamp: 1n,
  };
  assert.deepEqual(decodeAdvert(encodeAdvert(a)).guardianOf, a.guardianOf);
  assert.throws(() => encodeAdvert({ ...a, guardianOf: [...a.guardianOf].reverse() }), /not sorted/);
  assert.throws(() => encodeAdvert({ ...a, guardianOf: [{ federationId: FED, guardianKey: b32(1) }] }));
});

test('three of four guardians bonded meets a threshold of three; two does not', () => {
  const g = (n) => [{ federationId: FED, guardianKey: key(n) }];
  assert.deepEqual(ask([entry(1, g(1)), entry(2, g(2)), entry(3, g(3))]), { ok: true, bonded: 3, threshold: 3 });
  const two = ask([entry(1, g(1)), entry(2, g(2))]);
  assert.equal(two.ok, false);
  assert.match(two.why, /2 of that federation's 4 guardians are bonded census nodes, and its threshold is 3/);
});

test('one operator, an under-bonded node, another federation and a stranger key count once or not at all', () => {
  const both = [{ federationId: FED, guardianKey: key(1) }, { federationId: FED, guardianKey: key(2) }];
  const census = [
    entry(1, both),                                              // one node, two keys: one
    entry(2, [{ federationId: FED, guardianKey: key(3) }], 49999n), // under the bond minimum
    entry(3, [{ federationId: b32(0xfd), guardianKey: key(4) }]),   // another federation
    entry(4, [{ federationId: FED, guardianKey: key(9) }]),         // not in the config
    entry(5, [{ federationId: FED, guardianKey: key(1) }]),         // key 1 again
  ];
  assert.equal(ask(census).bonded, 1);
});

test('a round naming no federation, or a config with no usable threshold, is refused by name', () => {
  assert.match(ask([], { federationId: new Uint8Array(32) }).why, /names no federation/);
  assert.match(ask([], { threshold: 5 }).why, /no usable threshold/);
  assert.match(ask([], { guardianKeys: [b32(1)] }).why, /no 33-byte guardian keys/);
});
