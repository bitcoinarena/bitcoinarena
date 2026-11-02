// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY'S RULES (spec 5A.3B, RULED 2026-11-02, kanban #1021, rulings 2, 4 and 5). No curve: these are sums, bytes and an order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  censusKeyShares, censusKeyEpochOf, encodeCensusKeyRecord, decodeCensusKeyRecord, censusKeyRecordId, censusKeyAnchor, censusKeyAnchorIn,
  censusKeyRecordStands, standingCensusKeys, bondNamesStandingKey, censusKeyPlan,
} from '../src/census-key.js';
import { taggedHash, toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = (n, bondSats) => ({ pubkey: b32(n), bondSats });
const of = (entries, B = 100000n, S = 1024) => censusKeyShares({ entries, lowestBondMinSats: B, sharesMax: S });

test('unit = max(B, ceil(T / S)): the floor rules a small census, the cap a large one', () => {
  const small = of([entry(1, 300000n), entry(2, 100000n), entry(3, 250000n)]);
  assert.deepEqual([small.unit, small.total, small.threshold], [100000n, 6, 5]);
  assert.deepEqual(small.holders.map((h) => [h.key.slice(0, 2), h.shares, h.ids]), [['01', 3, [1, 2, 3]], ['02', 1, [4]], ['03', 2, [5, 6]]]);
  const large = of(Array.from({ length: 300 }, (_, i) => entry(i % 250 + 1, 1000000n * BigInt(1 + i % 7))));
  assert.equal(large.unit, (large.totalSats + 1023n) / 1024n);
  assert.ok(large.total <= 1024, `${large.total} shares`);
  console.log(`  FACTS: 250 nodes, ${large.totalSats} sats: unit ${large.unit}, ${large.total} shares, threshold ${large.threshold}`);
});

test('a node under one unit holds no share, never a minimum of one: many small bonds do not out-count capital', () => {
  const r = of([entry(1, 1000000n), ...Array.from({ length: 50 }, (_, i) => entry(i + 2, 99999n))]);
  assert.deepEqual([r.total, r.holders.length], [10, 1]);
  const capped = of([entry(1, 1024000n), entry(2, 999n)], 1n);
  assert.equal(capped.unit, 1001n);
  assert.deepEqual(capped.holders.map((h) => h.shares), [1022]);
});

test('a node\'s bonds are one sum; the threshold is floor(2 x total / 3) + 1', () => {
  assert.equal(of([entry(1, 60000n), entry(1, 60000n)]).total, 1);
  assert.deepEqual([3, 15, 32, 1024].map((n) => of([entry(1, BigInt(n) * 100000n)]).threshold), [3, 11, 22, 683]);
  assert.throws(() => censusKeyShares({ entries: [], lowestBondMinSats: 0n, sharesMax: 1 }), /bond_min/);
  assert.throws(() => censusKeyShares({ entries: [], lowestBondMinSats: 1n, sharesMax: 0 }), /shares_max/);
});

test('an epoch is bond_maturity long', () => {
  assert.deepEqual([0, 4319, 4320, 8640].map((h) => censusKeyEpochOf(h, 'mainnet')), [0, 0, 1, 2]);
  assert.equal(censusKeyEpochOf(158400, 'testnet4'), 1100);
  assert.throws(() => censusKeyEpochOf(1, 'nowhere'), /no epoch length/);
});

const record = { networkId: b32(9), epoch: 3, publicKey: b32(0x44), censusHeight: 12960, totalShares: 6, threshold: 5, transcriptHash: b32(0x55) };

test('CensusKeyRecord: the ruling\'s fields in order, anchored by "ARN" K and its hash', () => {
  const h = (n, x) => toHex(new Uint8Array(n).fill(x));
  const bytes = `${h(32, 9)}00000003${h(32, 0x44)}000032a00000000600000005${h(32, 0x55)}`;
  assert.equal(toHex(encodeCensusKeyRecord(record)), bytes);
  assert.deepEqual(decodeCensusKeyRecord(encodeCensusKeyRecord(record)), record);
  assert.equal(toHex(censusKeyRecordId(record)), toHex(taggedHash('ARENA/v1/CensusKeyRecord', encodeCensusKeyRecord(record))));
  const anchor = censusKeyAnchor(record);
  assert.equal(toHex(anchor.script.subarray(0, 6)), '6a24' + '41524e4b');
  assert.equal(toHex(censusKeyAnchorIn([{ script: Uint8Array.of(0x51) }, anchor])), toHex(censusKeyRecordId(record)));
  assert.equal(censusKeyAnchorIn([{ script: Uint8Array.of(0x6a, 2, 1, 2) }]), null);
});

test('a record stands only with the census\' own counts and signatures holding its threshold', () => {
  const shares = of([entry(1, 300000n), entry(2, 100000n), entry(3, 250000n)]);
  const verify = (sig, digest, key) => sig[0] === key[0];
  const sign = (n) => ({ key: b32(n), signature: b32(n) });
  const stands = (signatures, over = {}) => censusKeyRecordStands({ record, signatures, networkId: b32(9), shares, verify, ...over });
  assert.equal(stands([sign(1), sign(3)]).ok, true, '5 of 6');
  assert.match(stands([sign(1), sign(2)]).why, /4 shares/);
  assert.match(stands([sign(1), sign(1), sign(2)]).why, /4 shares/, 'a key counts once');
  assert.match(stands([sign(1), { key: b32(3), signature: b32(1) }]).why, /3 shares/, 'a bad signature counts for nothing');
  assert.match(stands([sign(1), sign(7), sign(3)], { networkId: b32(8) }).why, /another network/);
  assert.match(stands([sign(1), sign(3)], { record: { ...record, totalShares: 7 } }).why, /census at its height/);
  assert.match(stands([sign(1), sign(3)], { verify: undefined }).why, /verifier/);
});

const K = (n) => b32(n);
const judge = (table) => (id) => table[toHex(id)];

test('the census reads the first valid record per epoch, in chain order, and mainnet\'s key 0 needs no anchor', () => {
  const id = (n) => b32(n);
  const table = judge({
    [toHex(id(1))]: { ok: true, record: { epoch: 1, publicKey: K(0xa1) } },
    [toHex(id(2))]: { ok: true, record: { epoch: 1, publicKey: K(0xa2) } },
    [toHex(id(3))]: { ok: false },
    [toHex(id(4))]: { ok: true, record: { epoch: 2, publicKey: K(0xb1) } },
  });
  const anchors = [{ height: 200, index: 0, id: id(4) }, { height: 100, index: 3, id: id(2) }, { height: 100, index: 1, id: id(1) }, { height: 50, index: 0, id: id(3) }];
  const got = standingCensusKeys({ genesisKey: K(0x70), anchors, judge: table });
  assert.deepEqual(got.map((k) => [k.epoch, k.publicKey[0], k.height]), [[0, 0x70, 0], [1, 0xa1, 100], [2, 0xb1, 200]]);
  assert.equal(standingCensusKeys({ anchors: [], judge: table }).length, 0);
});

test('a template-3 bond counts only naming the newest key standing at its confirmation; other templates are not asked', () => {
  const standing = [{ epoch: 1, publicKey: K(0xa1), height: 100 }, { epoch: 2, publicKey: K(0xb1), height: 200 }];
  const advert = (key) => ({ bondScriptTemplateVersion: 3, censusKey: key });
  assert.equal(bondNamesStandingKey(advert(K(0xa1)), 150, standing).ok, true);
  assert.equal(bondNamesStandingKey(advert(K(0xb1)), 200, standing).ok, true, 'a record anchored in the bond\'s own block stands');
  assert.match(bondNamesStandingKey(advert(K(0xa1)), 200, standing).why, /newest standing/);
  assert.match(bondNamesStandingKey(advert(K(0xb1)), 150, standing).why, /newest standing/);
  assert.match(bondNamesStandingKey(advert(K(0xa1)), 99, standing).why, /cannot take a template-3 bond yet/);
  assert.match(bondNamesStandingKey(advert(K(0xa1)), 500, undefined).why, /cannot take a template-3 bond yet/);
  assert.deepEqual(bondNamesStandingKey({ bondScriptTemplateVersion: 2 }, 1, []), { ok: true });
});

test('the epoch\'s plan: retired, dead, one reshare, oldest first under 80 %, a new key only if the newest was named', () => {
  const key = (epoch, heldNow, named, totalShares = 100, threshold = 67) => ({ epoch, totalShares, threshold, heldNow, named });
  const plan = censusKeyPlan({ epochStart: true, keys: [key(1, 90, 0), key(2, 50, 4), key(3, 79, 2), key(4, 70, 1), key(5, 80, 3)] });
  assert.deepEqual([plan.retired.map((k) => k.epoch), plan.dead.map((k) => k.epoch), plan.reshare.epoch, plan.newKey], [[1], [2], 3, true]);
  const stable = censusKeyPlan({ keys: [key(1, 100, 1), key(2, 80, 1)] });
  assert.deepEqual([stable.reshare, stable.newKey], [null, false], 'a stable census costs nothing; only an epoch\'s start makes a key');
  assert.equal(censusKeyPlan({ epochStart: true, keys: [key(1, 100, 0)] }).newKey, false, 'a key nobody named is not followed by another');
  assert.equal(censusKeyPlan({ epochStart: true, keys: [] }).newKey, true);
});
