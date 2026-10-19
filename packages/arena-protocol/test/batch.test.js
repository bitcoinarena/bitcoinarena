// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The input batch, and the two properties a transcript is worth having for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { encodeInputBatch, decodeInputBatch, batchId, batchTicks, INPUT_WORDS, MAX_BATCH_TICKS, MAX_ATTEST_SIGS, MAX_ATTESTED_SAMPLES, MAX_INPUT_BATCH_BYTES } from '../src/batch.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 120,
  ticks: [[65536, 0, 0, 0, 0], [65536, -22000, 0, 0, 0], [0, 0, 65536, 0, 1]],
  liquidations: [[121, 3 * 65536]],
  loads: [[120, 17314, 42]],
});

test('a batch survives the round trip byte for byte', () => {
  const b = sample();
  const bytes = encodeInputBatch(b);
  const back = decodeInputBatch(bytes);
  assert.deepEqual(back.ticks, b.ticks);
  assert.deepEqual(back.liquidations, b.liquidations);
  assert.equal(back.firstTick, b.firstTick);
  assert.equal(toHex(encodeInputBatch(back)), toHex(bytes));
});

/**
 * THE LOAD, WHICH IS WHY A REPLAY IS HUNTED AT ALL.
 *
 * Heat was a host write straight into the page's core - in no batch, no mark
 * and no transcript - so the page carried 57229 and every replay of the same
 * inputs carried 0. What crosses is the bed rather than the answer: the sats
 * aboard and hundredths of a BTC, at the tick they were declared, and the core
 * decides the cost.
 */
test('the load is carried, sorted, and part of what a batch commits to', () => {
  const b = sample();
  const back = decodeInputBatch(encodeInputBatch(b));
  assert.deepEqual(back.loads, b.loads);

  // A batch with no load is a real batch - most of them are - and it must not
  // encode as one that forgot the field.
  const empty = { ...sample(), loads: [] };
  assert.deepEqual(decodeInputBatch(encodeInputBatch(empty)).loads, []);
  assert.notEqual(toHex(batchId(b)), toHex(batchId(empty)),
    'a run declaring a load and one declaring none hash the same');

  // Sorted before it is hashed, for the liquidations' reason: two nodes that
  // received the same declarations in a different order encode the same bytes.
  const one = { ...sample(), loads: [[120, 17314, 42], [300, 9000, 0]] };
  const other = { ...sample(), loads: [[300, 9000, 0], [120, 17314, 42]] };
  assert.equal(toHex(batchId(one)), toHex(batchId(other)));

  // And a changed bed is a changed batch, or a load could be swapped after the
  // chain was built.
  const fatter = { ...sample(), loads: [[120, 17315, 42]] };
  assert.notEqual(toHex(batchId(b)), toHex(batchId(fatter)));
});

test('the tick numbers are absolute, so a gap is visible in the message itself', () => {
  const b = sample();
  assert.deepEqual(batchTicks(b), [120, 121, 122]);
  const later = { ...b, firstTick: 125 };
  // 123 and 124 are simply absent - nothing has to remember they were expected
  assert.deepEqual(batchTicks(later), [125, 126, 127]);
});

test('the same batch always encodes the same bytes, whatever order it arrived in', () => {
  const a = sample();
  const b = { ...sample(), liquidations: [[121, 3 * 65536]] };
  const c = { ...sample(), liquidations: [[121, 3 * 65536], [121, 3 * 65536]].slice(0, 1) };
  assert.equal(toHex(batchId(a)), toHex(batchId(b)));
  assert.equal(toHex(batchId(a)), toHex(batchId(c)));
});

test('liquidations are sorted before they are hashed', () => {
  const one = { ...sample(), liquidations: [[300, 5], [121, 9]] };
  const other = { ...sample(), liquidations: [[121, 9], [300, 5]] };
  assert.equal(toHex(batchId(one)), toHex(batchId(other)),
    'two nodes that received them in a different order must agree');
});

test('a tick carries exactly the five words `step` takes', () => {
  assert.equal(INPUT_WORDS, 5);
  const bad = { ...sample(), ticks: [[1, 2, 3, 4]] };
  assert.throws(() => encodeInputBatch(bad), /five words/);
});

test('a batch of another type, or with anything after it, is refused', () => {
  const bytes = encodeInputBatch(sample());
  const wrongType = bytes.slice(); wrongType[0] = 0x01;
  assert.throws(() => decodeInputBatch(wrongType), /not an input batch/);
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
  assert.throws(() => decodeInputBatch(trailing), /trailing bytes/);
});

test('the id is tagged, so it cannot collide with a contract of the same bytes', () => {
  const bytes = encodeInputBatch(sample());
  // the tag is what separates them; the body alone would not
  assert.notEqual(toHex(batchId(sample())), toHex(bytes.slice(0, 32)));
  assert.equal(batchId(sample()).length, 32);
});

test('the chain field is carried, and changes the id', () => {
  const a = sample();
  const b = { ...sample(), previousHash: new Uint8Array(32).fill(3) };
  assert.notEqual(toHex(batchId(a)), toHex(batchId(b)),
    'two batches with the same inputs but different histories are different batches');
  assert.deepEqual(decodeInputBatch(encodeInputBatch(b)).previousHash, b.previousHash);
});

test('the ceiling the encoder sets is the one the transport is built on', () => {
  // Built, not reasoned about: the largest batch that can encode at all, so a
  // frame longer than this is not a protocol message and can be refused
  // without being parsed.
  const b = {
    roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 0,
    ticks: Array.from({ length: MAX_BATCH_TICKS }, () => [65536, 0, 0, 0, 0]),
    liquidations: Array.from({ length: MAX_BATCH_TICKS }, (_, i) => [i, 1]),
    loads: Array.from({ length: MAX_BATCH_TICKS }, (_, i) => [i, 1, 0, 5]),
    samples: Array.from({ length: MAX_BATCH_TICKS }, (_, i) => [i, 1]),
    tapes: [[0, ...Array.from({ length: 64 }, () => 1)]],
    // at their largest the attested prices are protocol 5's: nine signed readings each, their own prices with them
    attests: [...Array.from({ length: MAX_ATTESTED_SAMPLES }, (_, k) => [k * 300, 2, 8297193, Array.from({ length: MAX_ATTEST_SIGS }, (_, i) => [b32(i), 8297193, new Uint8Array(64).fill(i)])]),
      [0, 3, Array.from({ length: 64 }, () => 8290000), Array.from({ length: MAX_ATTEST_SIGS }, (_, i) => [b32(i), Array.from({ length: 64 }, () => 8290000), new Uint8Array(64).fill(i)])]],
  };
  assert.equal(encodeInputBatch(b).length, MAX_INPUT_BATCH_BYTES);
  // the same batch with 's attestations (kinds 0 and 1, nine signatures each) is 256 x 36 + 9 x 256 bytes shorter
  const v4 = { ...b, attests: [...Array.from({ length: MAX_ATTESTED_SAMPLES }, (_, k) => [k * 300, 0, 8297193, Array.from({ length: MAX_ATTEST_SIGS }, (_, i) => [b32(i), new Uint8Array(64).fill(i)])]),
    [0, 1, Array.from({ length: 64 }, () => 8290000), Array.from({ length: MAX_ATTEST_SIGS }, (_, i) => [b32(i), new Uint8Array(64).fill(i)])]] };
  assert.equal(encodeInputBatch(v4).length, MAX_INPUT_BATCH_BYTES - 256 * 36 - 9 * 256);
  // + 2 + 65535 x 8 for the price samples and + 2 + 260 for the one live tape a batch may carry (2026-09-17);
  // + 2 + 65535 x 8 for the rooms; + 2 + 256 x 875 + 1127 for the attested samples and tape, nine signatures each;
  // protocol 5's readings carry their own cents (+4 each) and a tape reading its 64 prices (+256 each)
  assert.equal(MAX_INPUT_BATCH_BYTES, 2621509 + 2 + MAX_BATCH_TICKS * 8 + 2 + 260 + 2 + MAX_BATCH_TICKS * 8 + 2 + 256 * (875 + 36) + 1127 + 9 * 256);
});

test('the committee\'s signatures on a sample and the tape: a fourth optional tail; a batch without them keeps its bytes', () => {
  const plain = { ...sample(), samples: [[300, 2124081]] };
  const before = encodeInputBatch(plain);
  assert.deepEqual(encodeInputBatch({ ...plain, attests: [] }), before, 'no attestation: the same bytes and id');
  const sig = (i) => [b32(i), new Uint8Array(64).fill(i)];
  const withA = { ...plain, attests: [[300, 0, 8297193, [sig(1), sig(2)]]] };
  const back = decodeInputBatch(encodeInputBatch(withA));
  assert.deepEqual(back.attests, withA.attests);
  assert.deepEqual(back.samples, plain.samples);
  assert.notEqual(toHex(batchId(withA)), toHex(batchId(plain)));
  assert.throws(() => encodeInputBatch({ ...plain, attests: [[300, 0, 1, []], [300, 0, 2, []]] }), /one attested sample a tick/);
  assert.equal(decodeInputBatch(encodeInputBatch({ ...plain, attests: [[300, 0, 1, []], [600, 0, 2, []]] })).attests.length, 2, 'two samples of a stall: two ticks');
  assert.throws(() => encodeInputBatch({ ...plain, attests: [[300, 0, 1, Array.from({ length: MAX_ATTEST_SIGS + 1 }, (_, i) => sig(i))]] }), /at most 9 signatures/);
});

test('a tick costs twenty bytes, a liquidation eight and a load twelve', () => {
  const at = (n, l, d = 0) => encodeInputBatch({
    roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 0,
    ticks: Array.from({ length: n }, () => [65536, 0, 0, 0, 0]),
    liquidations: Array.from({ length: l }, (_, i) => [i, 1]),
    loads: Array.from({ length: d }, (_, i) => [i, 1, 0]),
  }).length;
  assert.equal(at(0, 0), 109, 'the header, and the load vector\'s own length word');
  assert.equal(at(1, 0) - at(0, 0), 20);
  assert.equal(at(0, 1) - at(0, 0), 8);
  assert.equal(at(0, 0, 1) - at(0, 0), 12);
  assert.equal(at(6, 0), 229, 'six ticks is one send at the spec\'s 10 Hz');
});

/**
 * THE PRICE SAMPLES (2026-09-17 16:01: the chart was frozen - nothing ever submitted one). A sample moves the
 * tape, so it is carried like a liquidation: `[tick, price]`, sorted, committed to - and written only when there are
 * any, so every batch recorded before samples existed keeps its bytes and its id.
 */
test('price samples are carried, sorted, committed to, and a batch without them keeps its old bytes', () => {
  const plain = sample();
  const before = toHex(encodeInputBatch(plain));
  assert.equal(toHex(encodeInputBatch({ ...plain, samples: [] })), before, 'an empty sample list changed the bytes');
  assert.deepEqual(decodeInputBatch(encodeInputBatch(plain)).samples, []);

  const priced = { ...sample(), samples: [[300, 20099840], [120, 20101447]] };
  const bytes = encodeInputBatch(priced);
  assert.equal(bytes.length - encodeInputBatch(plain).length, 2 + 2 * 8, 'a sample costs eight bytes and the vector two');
  const back = decodeInputBatch(bytes);
  assert.deepEqual(back.samples, [[120, 20101447], [300, 20099840]]);
  assert.equal(toHex(encodeInputBatch(back)), toHex(bytes));
  assert.equal(toHex(batchId(priced)), toHex(batchId({ ...sample(), samples: [[120, 20101447], [300, 20099840]] })), 'order changed the id');
  assert.notEqual(toHex(batchId(priced)), toHex(batchId(plain)));
  assert.notEqual(toHex(batchId(priced)), toHex(batchId({ ...sample(), samples: [[120, 20101448], [300, 20099840]] })), 'a changed price kept the id');

  // one encoding per batch: an explicitly empty sample vector is not canonical
  const withEmpty = new Uint8Array([...encodeInputBatch(plain), 0, 0]);
  assert.throws(() => decodeInputBatch(withEmpty));
});

/**
 * THE LIVE TAPE (2026-09-17 16:44: reload showed the same seeded candles). The 64 live prices a page hands its core
 * before any sample: one a batch, kept in their own order, committed to, and absent from a batch without one.
 */
test('a live tape is carried in its own order, one a batch, and a batch without one keeps its bytes', () => {
  const prices = Array.from({ length: 64 }, (_, i) => 19640000 + ((i * 7919) % 5000));
  const plain = sample();
  assert.equal(toHex(encodeInputBatch({ ...plain, tapes: [] })), toHex(encodeInputBatch(plain)));
  const taped = { ...sample(), tapes: [[120, ...prices]] };
  const bytes = encodeInputBatch(taped);
  assert.equal(bytes.length - encodeInputBatch(plain).length, 2 + 2 + 4 + 64 * 4, 'the empty sample vector, the tape vector and one tape');
  const back = decodeInputBatch(bytes);
  assert.deepEqual(back.tapes, [[120, ...prices]]);
  assert.deepEqual(back.samples, []);
  assert.equal(toHex(encodeInputBatch(back)), toHex(bytes));
  const swapped = prices.slice(); [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.notEqual(toHex(batchId(taped)), toHex(batchId({ ...sample(), tapes: [[120, ...swapped]] })), 'the order of the prices is not committed to');
  assert.throws(() => encodeInputBatch({ ...sample(), tapes: [[120, ...prices], [121, ...prices]] }), /at most one tape/);
  assert.throws(() => encodeInputBatch({ ...sample(), tapes: [[120, ...prices.slice(1)]] }), /64 prices/);
  // samples and a tape together
  const both = { ...sample(), samples: [[300, 19650000]], tapes: [[120, ...prices]] };
  assert.deepEqual(decodeInputBatch(encodeInputBatch(both)).samples, [[300, 19650000]]);
});
