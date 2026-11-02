// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY'S RULES (spec 5A.3B, RULED 2026-11-02, kanban #1021, rulings 2, 4 and 5). No curve: these are sums, bytes and an order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  censusKey0Shares, censusKeyShares, censusKeyDrawHeight, censusKeyWindow, carrierEscrowPegInId, censusKeyEpochOf, encodeCensusKeyRecord, decodeCensusKeyRecord, censusKeyRecordId, censusKeyAnchor, censusKeyAnchorIn,
  censusKeyRecordStands, standingCensusKeys, bondNamesStandingKey, censusKeyPlan, censusHeightOfEpoch, fallbackCarriers, carrierPegInId,
} from '../src/census-key.js';
import { taggedHash, toHex, bytesToBigInt } from '../src/hash.js';
import { CENSUS_KEY_BOND_MIN, censusKeyBondMin } from '../src/genesis.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = (n, bondSats, vout = 0) => ({ pubkey: b32(n), bondSats, txid: b32(n), vout });
const B = CENSUS_KEY_BOND_MIN.regtest;
const H = taggedHash('ARENA/test/Block', Uint8Array.of(1));
const of = (entries, over = {}) => censusKeyShares({ entries, network: 'regtest', blockHash: H, ...over });

test('exact while the sum of floor(bond / B) is at most S: shares by the floor, x in key order, and H is not read (kanban #1034)', () => {
  const small = of([entry(1, 3n * B), entry(2, B), entry(3, 2n * B + 25000n)], { blockHash: null });
  assert.deepEqual([small.drawn, small.total, small.threshold], [false, 6, 5]);
  assert.deepEqual(small.holders.map((h) => [h.key.slice(0, 2), h.shares, h.ids]), [['01', 3, [1, 2, 3]], ['02', 1, [4]], ['03', 2, [5, 6]]]);
  const edge = of(Array.from({ length: 8 }, (_, i) => entry(i + 1, 128n * B)), { blockHash: null });
  assert.deepEqual([edge.drawn, edge.total, edge.threshold], [false, 1024, 683], 'exactly S is still exact');
});

test('one unit past S the shares are drawn: S of them, every x once, threshold 683 of 1024', () => {
  const r = of([...Array.from({ length: 8 }, (_, i) => entry(i + 1, 128n * B)), entry(9, B)]);
  assert.deepEqual([r.drawn, r.total, r.threshold], [true, 1024, 683]);
  assert.deepEqual(r.holders.flatMap((h) => h.ids).sort((a, b) => a - b), Array.from({ length: 1024 }, (_, i) => i + 1));
  assert.deepEqual(r.holders.map((h) => h.key), [...r.holders.map((h) => h.key)].sort(), 'holders in key order');
  assert.deepEqual(of([...Array.from({ length: 8 }, (_, i) => entry(i + 1, 128n * B)), entry(9, B)].reverse()), r, 'the same on every node, whatever order it reads them in');
  assert.notDeepEqual(of([...Array.from({ length: 8 }, (_, i) => entry(i + 1, 128n * B)), entry(9, B)], { blockHash: b32(7) }).holders, r.holders, 'another block, another draw');
});

test('the draw, by hand: tagged_hash over h || i (four bytes, big-endian) mod T, stretches in ascending lowest outpoint', () => {
  const entries = [{ pubkey: b32(1), bondSats: 7n * B, txid: b32(0xc0), vout: 0 }, { pubkey: b32(2), bondSats: 5n * B, txid: b32(0xa0), vout: 1 }, { pubkey: b32(3), bondSats: 3n * B, txid: b32(0xb0), vout: 0 },
    { pubkey: b32(3), bondSats: B, txid: b32(0xa0), vout: 0 }];
  const r = of(entries, { sharesMax: 12, blockHash: b32(0x42) });
  const T = 16n * B;
  const order = [['03', 4n * B], ['02', 5n * B], ['01', 7n * B]];           // 03 by (a0, 0), 02 by (a0, 1), 01 by (c0, 0)
  const want = new Map(order.map(([k]) => [k, []]));
  for (let i = 0; i < 12; i++) {
    const tag = createHash('sha256').update('ARENA/v1/CensusKeyShare').digest();
    const hash = createHash('sha256').update(tag).update(tag).update(b32(0x42)).update(Uint8Array.of(0, 0, 0, i)).digest();
    let x = bytesToBigInt(hash) % T;
    for (const [k, len] of order) { if (x < len) { want.get(k).push(i + 1); break; } x -= len; }
  }
  assert.deepEqual(r.holders.map((h) => [h.key.slice(0, 2), h.ids]), ['01', '02', '03'].map((k) => [k, want.get(k)]).filter(([, v]) => v.length));
  console.log('  FACTS:', JSON.stringify(r.holders.map((h) => [h.key.slice(0, 2), h.ids])));
});

test('a drawn key has no floor: a node under B can hold a share, a share is linear in sats, and splitting a bond changes nothing', () => {
  const large = Array.from({ length: 2000 }, (_, i) => entry((i % 200) + 1, i % 200 === 0 ? 5000n * B : B / 2n + BigInt(i)));
  const counts = new Map();
  for (let d = 0; d < 400; d++) for (const h of of(large, { blockHash: taggedHash('ARENA/test/Block', Uint8Array.of(d & 255, d >> 8)) }).holders) counts.set(h.key, (counts.get(h.key) || 0) + h.shares);
  const sums = new Map();
  for (const e of large) sums.set(toHex(e.pubkey), (sums.get(toHex(e.pubkey)) || 0n) + e.bondSats);
  const T = [...sums.values()].reduce((a, v) => a + v, 0n);
  for (const [k, sats] of sums) {
    const want = Number(sats) / Number(T) * 400 * 1024, got = counts.get(k) || 0;
    assert.ok(Math.abs(got - want) < 6 * Math.sqrt(want) + 1, `${k.slice(0, 2)} drew ${got}, ${want.toFixed(0)} expected`);
  }
  const tiny = of([entry(1, 2000n * B), entry(2, 1000n)]);
  const manyDraws = Array.from({ length: 200 }, (_, d) => of([entry(1, 2000n * B), entry(2, B - 1n)], { blockHash: taggedHash('ARENA/test/Block', Uint8Array.of(d)) }));
  assert.ok(tiny.drawn && manyDraws.some((r) => r.holders.some((h) => h.key.startsWith('02'))), 'a node under B drew a share');
  const one = of([entry(1, 2000n * B), { ...entry(2, 8000n * B) }]);
  const split = of([entry(1, 2000n * B), { ...entry(2, 3000n * B), vout: 0 }, { ...entry(2, 5000n * B), vout: 1 }]);
  assert.deepEqual(split.holders, one.holders, 'one sum, one stretch, at its lowest outpoint');
});

test('a drawn key names what it reads; bytes and hex name one outpoint; a node\'s bonds are one sum; the threshold is floor(2 x total / 3) + 1', () => {
  const big = [entry(1, 2000n * B), entry(2, B)];
  assert.throws(() => of(big, { blockHash: null }), /block hash/);
  assert.throws(() => of([{ pubkey: b32(1), bondSats: 2000n * B }]), /lowest outpoint/);
  assert.deepEqual(of(big.map((e) => ({ ...e, txid: toHex(e.txid) }))), of(big));
  assert.equal(of([entry(1, 30000n), entry(1, 30000n, 1)]).total, 1);
  assert.deepEqual([3, 15, 32, 1024].map((n) => of([entry(1, BigInt(n) * B)]).threshold), [3, 11, 22, 683]);
  assert.throws(() => of([], { sharesMax: 0 }), /shares_max/);
});

test('B is the network\'s and no caller\'s: testnet4 50,000 sat, mainnet from its genesis (kanban #1034 answer 3)', () => {
  assert.equal(censusKeyBondMin('testnet4'), 50000n);
  assert.equal(censusKeyBondMin('regtest'), 50000n);
  assert.equal(censusKeyBondMin('mainnet', { censusKeyBondMinSats: 1000000n }), 1000000n);
  assert.throws(() => censusKeyBondMin('mainnet'), /genesis/);
  assert.throws(() => censusKeyBondMin('nowhere'), /no census key bond floor/);
  const mine = (n) => censusKeyShares({ entries: [entry(1, 3000000n)], network: 'mainnet', genesis: { censusKeyBondMinSats: n } }).total;
  assert.deepEqual([mine(1000000n), mine(500000n)], [3, 6]);
  assert.equal(censusKeyShares({ entries: [entry(1, 3000000n)], network: 'testnet4', lowestBondMinSats: 1n }).total, 60, 'a passed B is not read');
});

test('a draw reads the epoch\'s first block, and its window is founding_window from there, deals then signatures (kanban #1034 answer 5)', () => {
  assert.equal(censusKeyDrawHeight(2, 'mainnet'), 8640);
  assert.ok(censusKeyDrawHeight(2, 'mainnet') > censusHeightOfEpoch(2, 'mainnet', 6), 'after the census cut');
  assert.deepEqual(censusKeyWindow(2, 'mainnet', 432), { start: 8640, midpoint: 8856, end: 9072 });
  assert.deepEqual(censusKeyWindow(1, 'testnet4', 18), { start: 144, midpoint: 153, end: 162 });
  assert.throws(() => censusKeyWindow(1, 'mainnet', 1), /founding_window/);
  assert.throws(() => censusKeyDrawHeight(1, 'nowhere'), /no epoch length/);
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
  const shares = of([entry(1, 3n * B), entry(2, B), entry(3, 2n * B + 25000n)]);
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

test('a template-3 bond counts naming a key newest within census_confirmations of its confirmation (kanban #1031)', () => {
  const standing = [{ epoch: 1, publicKey: K(0xa1), height: 100 }, { epoch: 2, publicKey: K(0xb1), height: 200 }, { epoch: 3, publicKey: K(0xc1), height: 400 }];
  const advert = (key) => ({ bondScriptTemplateVersion: 3, censusKey: key });
  assert.equal(bondNamesStandingKey(advert(K(0xa1)), 205, standing, 6).ok, true, 'it lost the race with an anchor 5 blocks ago');
  assert.equal(bondNamesStandingKey(advert(K(0xa1)), 206, standing, 6).ok, false, 'at the window\'s edge the newer key has stood 6 blocks');
  assert.equal(bondNamesStandingKey(advert(K(0xb1)), 206, standing, 6).ok, true);
  assert.equal(bondNamesStandingKey(advert(K(0xa1)), 402, standing, 6).ok, false, 'an older key, out of reach');
  assert.equal(bondNamesStandingKey(advert(K(0xc1)), 399, standing, 6).ok, false, 'a key not anchored yet');
});

test('the census height of an epoch is e x E - census_confirmations; before that the first key applies (kanban #1031)', () => {
  assert.equal(censusHeightOfEpoch(2, 'mainnet', 6), 8634);
  assert.equal(censusHeightOfEpoch(1, 'testnet4', 2), 142);
  assert.equal(censusHeightOfEpoch(0, 'mainnet', 6), null);
  assert.throws(() => censusHeightOfEpoch(1, 'nowhere', 1), /no epoch length/);
});

test('on a fallback the holders carry, by descending shares, less those left out, each with a signed peg-in (kanban #1031)', () => {
  const net = b32(9);
  const holders = [{ key: toHex(b32(1)), shares: 2 }, { key: toHex(b32(2)), shares: 9 }, { key: toHex(b32(3)), shares: 5 }, { key: toHex(b32(4)), shares: 7 }, { key: toHex(b32(5)), shares: 3 }];
  const peg = (n, ok = true) => [toHex(b32(n)), { script: Uint8Array.of(0x51, n), signature: ok ? Uint8Array.of(n) : Uint8Array.of(0) }];
  const bonds = new Map(holders.map((h) => [h.key, BigInt(h.shares) * 1000n]));
  const verify = (sig, digest, key) => sig[0] === key[0] && digest.length === 32;
  const got = fallbackCarriers({ holders, bonds, networkId: net, verify, excluded: [toHex(b32(2))], pegIns: new Map([peg(1), peg(2), peg(3), peg(4, false), peg(5)]) });
  assert.deepEqual(got.map((c) => [c.key.slice(0, 2), c.bondSats]), [['03', 5000n], ['05', 3000n], ['01', 2000n]], 'the accused out, a bad signature passed over');
  assert.equal(carrierPegInId(net, Uint8Array.of(1)).length, 32);
  assert.deepEqual(fallbackCarriers({ holders, bonds, networkId: net, verify, pegIns: new Map() }), [], 'no holder with a peg-in is no refusal: the table waits in escrow');
  assert.notEqual(toHex(carrierEscrowPegInId(b32(1), Uint8Array.of(1))), toHex(carrierEscrowPegInId(b32(2), Uint8Array.of(1))), 'an escrow peg-in names its table');
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

test('census key 0 reads as any key: one share each, x its place in genesis, holders in ascending key (kanban #1050)', () => {
  const holders = [K(3), K(1), K(2), K(4)];
  const got = censusKey0Shares({ publicKey: K(0x70), holders, threshold: 3 });
  assert.deepEqual(got.holders.map((h) => [h.key, h.shares, h.ids[0]]), [[toHex(K(1)), 1, 2], [toHex(K(2)), 1, 3], [toHex(K(3)), 1, 1], [toHex(K(4)), 1, 4]]);
  assert.equal(got.total, 4);
  assert.equal(got.threshold, 3);
  const plan = censusKeyPlan({ keys: [{ epoch: 0, named: 2, totalShares: got.total, threshold: got.threshold, heldNow: 3 }] });
  assert.equal(plan.reshare.epoch, 0, 'three of four founders in the census is under 80 %, and over the threshold');
});
