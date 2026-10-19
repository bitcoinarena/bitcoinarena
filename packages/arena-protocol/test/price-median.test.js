// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROTOCOL 5: THE MEDIAN OF SIGNED READINGS (RULED 2026-10-14 ~21:50Z: "each seat signs the price it read,
// and the sample is the median of five signed readings"). What needs no signature: the median's rule, the version, the batch
// layout of the readings - and that a round below 5 keeps every byte it had (pinned from origin/main 7f04592b).
// The signed readings themselves are checked in arena-node/test/price-median.test.js (it has the curve).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { medianOf, priceSampleId, priceTapeId, priceReadingId, priceTapeReadingId, PRICE_TAPE_LENGTH } from '../src/price-sample.js';
import { roundResultId, frontOfRun } from '../src/round-result.js';
import { encodeInputBatch, decodeInputBatch, batchId, MAX_ATTEST_SIGS } from '../src/batch.js';
import { speaksVersion, SUPPORTED_PROTOCOL_VERSIONS, PRICE_MEDIAN_VERSION, mediansPrices } from '../src/constants.js';
import { protocolVersionName } from '../src/protocol-version.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const tape = Array.from({ length: PRICE_TAPE_LENGTH }, (_, i) => 8290000 + i);

test('the median: sorted ascending, an odd count the middle reading, an even count the lower middle - 5, 6 and 7 readings', () => {
  assert.equal(medianOf([8297400, 8297000, 8297300, 8297100, 8297200]), 8297200, 'five: the third');
  assert.equal(medianOf([8297500, 8297000, 8297300, 8297100, 8297200, 8297400]), 8297200, 'six: the lower of the middle two (8297200 / 8297300), never their average');
  assert.equal(medianOf([8297600, 8297000, 8297300, 8297100, 8297200, 8297400, 8297500]), 8297300, 'seven: the fourth');
  const v = [3, 1, 2]; medianOf(v); assert.deepEqual(v, [3, 1, 2], 'the readings are not reordered');
  assert.throws(() => medianOf([]), /median of nothing/);
});

test('an outlier cannot move the median beyond the honest range: two of seven lying, high or low or both', () => {
  const honest = [8297000, 8297100, 8297200, 8297300, 8297400];
  for (const liars of [[999999999, 999999999], [1, 1], [1, 999999999]]) {
    const m = medianOf([...honest, ...liars]);
    assert.ok(m >= Math.min(...honest) && m <= Math.max(...honest), `${liars}: ${m}`);
  }
  // and of any five of the seven (whoever assembles a sample from more than five): still a middle honest reading
  const all = [...honest, 1, 999999999];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const five = all.filter((_, i) => i !== a && i !== b);
    const m = medianOf(five);
    assert.ok(m >= 8297000 && m <= 8297400, `without ${a},${b}: ${m}`);
  }
});

test('protocol 5 is 2026.0.5: spoken, named, and it is the round\'s version that picks the median', () => {
  assert.equal(PRICE_MEDIAN_VERSION, 5);
  assert.equal(speaksVersion(5), true);
  // version 5 is spoken (was a pinned [1 .. 7], stale since 8 and 9 were added -)
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(5));
  assert.equal(protocolVersionName(5), '5');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((v) => mediansPrices({ protocolVersion: v })), [false, false, false, false, true, true, true]);
  assert.equal(mediansPrices(null), false);
});

test('a reading is one seat\'s price of one moment under its own tag: any change is another id, and never a proposed sample\'s', () => {
  const r = { roundId: b32(9), tick: 300, priceCents: 8297193 };
  const id = toHex(priceReadingId(r));
  for (const other of [{ ...r, tick: 301 }, { ...r, priceCents: 8297194 }, { ...r, roundId: b32(8) }]) assert.notEqual(toHex(priceReadingId(other)), id);
  assert.notEqual(id, toHex(priceSampleId(r)), 'a reading is not a sample: a v4 signature never stands as a reading');
  assert.throws(() => priceReadingId({ ...r, priceCents: 0 }), /positive number of cents/);
  const t = { roundId: b32(9), tick: 0, prices: tape };
  assert.notEqual(toHex(priceTapeReadingId(t)), toHex(priceTapeId(t)));
  assert.throws(() => priceTapeReadingId({ ...t, prices: tape.slice(1) }), /64 prices/);
});

test('a batch carries a protocol-5 sample (kind 2) and tape (kind 3) with each seat\'s own reading, and reads them back', () => {
  const reading = (n, c) => [b32(n), c, new Uint8Array(64).fill(n)];
  const tapeReading = (n) => [b32(n), tape.map((p) => p + n), new Uint8Array(64).fill(n)];
  const b = { roundId: b32(1), entryId: b32(2), previousHash: b32(3), firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [],
    samples: [[300, 21240814]], tapes: [[0, ...tape.map((c) => Math.floor((c * 256 + 50) / 100))]],
    attests: [[300, 2, 8297193, [reading(1, 8297100), reading(2, 8297193), reading(3, 8297300)]], [0, 3, tape, [tapeReading(4), tapeReading(5)]]] };
  const back = decodeInputBatch(encodeInputBatch(b));
  assert.deepEqual(back.attests, [...b.attests].sort((x, y) => x[1] - y[1] || x[0] - y[0]));
  assert.throws(() => encodeInputBatch({ ...b, attests: [[300, 0, 1, []], [300, 2, 1, []]] }), /one attested sample a tick/, 'one sample a tick, of either kind');
  assert.throws(() => encodeInputBatch({ ...b, attests: [[0, 1, tape, []], [0, 3, tape, []]] }), /at most one attested tape/);
  assert.throws(() => encodeInputBatch({ ...b, attests: [[300, 4, 1, []]] }), /one attested sample a tick/, 'no fifth kind');
  assert.throws(() => encodeInputBatch({ ...b, attests: [[300, 2, 1, Array.from({ length: MAX_ATTEST_SIGS + 1 }, (_, i) => reading(i, 1))]] }), /at most 9 signatures/);
  assert.throws(() => encodeInputBatch({ ...b, attests: [[0, 3, tape, [[b32(1), tape.slice(1), new Uint8Array(64)]]]] }), /64 prices/);
});

// A ROUND BELOW 5 KEEPS ITS PATH BYTE FOR BYTE: the values below were printed by origin/main 7f04592b's own code
test('below protocol 5 every byte is as it was: an attested batch (kinds 0 and 1), the sample, tape and result ids, the run\'s front', () => {
  const sig = (n) => [b32(n), new Uint8Array(64).fill(n)];
  const b = { roundId: b32(1), entryId: b32(2), previousHash: b32(3), firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [],
    samples: [[300, 21240814]], tapes: [[0, ...tape.map((c) => Math.floor((c * 256 + 50) / 100))]],
    attests: [[300, 0, 8297193, [sig(1), sig(2), sig(3)]], [0, 1, tape, [sig(4), sig(5)]]] };
  const bytes = encodeInputBatch(b);
  assert.equal(bytes.length, 1159);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'afe6f2bedc7755ef2a0d5281a8be70fa3955a570907c7c1a9c2813f0b72f075d');
  assert.equal(toHex(batchId(b)), '136d9f7e5ff5a9a83e31aa55c4a1bf32cf7b2bcf7a2b34fa3c4878d1a8788d6a');
  assert.equal(toHex(priceSampleId({ roundId: b32(9), tick: 300, priceCents: 8297193 })), '96401b915920c015916a4fe57350dee7f855998e91a36a49bcf006e345ea22fa');
  assert.equal(toHex(priceTapeId({ roundId: b32(9), tick: 0, prices: tape })), '20062ab176486bd852668e0fe71565ad342de7dbefe380b7fa499e2f9673401a');
  assert.equal(toHex(roundResultId({ roundId: b32(9), openCents: 8297000, closeCents: 8300500 })), 'b7af2d79d4e8d3be01cdc84750ba85be84fe9573ddfa307d53e4bb5510638569');
  assert.deepEqual(frontOfRun([{ attests: [[0, 0, 8297000, []]] }, { attests: [[600, 0, 8296000, []]] }]), { front: 2, frontOpenCents: 8297000, frontCloseCents: 8296000, frontMode: 1 });
  // and a protocol-5 run's front reads its medians (kind 2) the same way
  assert.deepEqual(frontOfRun([{ attests: [[0, 2, 8297000, []]] }, { attests: [[600, 2, 8298000, []]] }]), { front: 1, frontOpenCents: 8297000, frontCloseCents: 8298000, frontMode: 1 });
});
