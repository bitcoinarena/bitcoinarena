// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROTOCOL 5 (RULED 2026-10-14 ~21:50Z): "each seat signs the price it read, and the sample is the median of
// five signed readings. Nobody proposes a price, so nobody chooses BULLS, BEARS, or FLAT." The signed readings: when a sample and
// a tape stand, what a batch of a protocol-5 round must carry, and the RoundResult made of medians.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  priceReadingId, priceTapeReadingId, priceSampleStands5, priceTapeStands5, checkBatchPrices, centsToTapeUnits, priceSampleId, PRICE_TAPE_LENGTH,
} from '../../arena-protocol/src/price-sample.js';
import { roundResultFromReadings, frontName } from '../../arena-protocol/src/round-result.js';
import { encodeInputBatch, decodeInputBatch } from '../../arena-protocol/src/batch.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 10); return { sk, pk: schnorr.getPublicKey(sk) }; });
const committee = seats.map((s) => s.pk);
const verify = (sig, msg, pk) => schnorr.verify(sig, msg, pk);
const roundId = b32(9);
const tick = 300;
const read = (s, priceCents, t = tick) => ({ key: s.pk, priceCents, signature: schnorr.sign(priceReadingId({ roundId, tick: t, priceCents }), s.sk) });
const stands = (readings, extra = {}) => priceSampleStands5({ roundId, tick, readings, committee, threshold: 5, verify, ...extra });

test('a sample is the median of five, six or seven signed readings - the lower middle of an even count - computed, never told', () => {
  const p = [8297400, 8297000, 8297300, 8297100, 8297200, 8297600, 8297500];
  const five = stands(seats.slice(0, 5).map((s, i) => read(s, p[i])));
  assert.deepEqual([five.ok, five.priceCents, five.count], [true, 8297200, 5]);
  const six = stands(seats.slice(0, 6).map((s, i) => read(s, p[i])));
  assert.deepEqual([six.ok, six.priceCents, six.count], [true, 8297200, 6], 'six: 8297200 and 8297300 in the middle, the lower');
  const seven = stands(seats.map((s, i) => read(s, p[i])));
  assert.deepEqual([seven.ok, seven.priceCents, seven.count], [true, 8297300, 7], 'more than five: all of them');
});

test('an outlier seat - or two - cannot move the median beyond the honest seats\' range', () => {
  const honest = [8297000, 8297100, 8297200, 8297300, 8297400];
  for (const liars of [[999999999, 999999999], [1, 1], [1, 999999999]]) {
    const s = stands([...honest.map((c, i) => read(seats[i], c)), read(seats[5], liars[0]), read(seats[6], liars[1])]);
    assert.equal(s.ok, true);
    assert.ok(s.priceCents >= 8297000 && s.priceCents <= 8297400, `${liars}: ${s.priceCents}`);
  }
});

test('a forged reading, a second reading by one key, a key outside the committee - each refuses the sample; fewer than five stand nothing', () => {
  const good = seats.slice(0, 5).map((s, i) => read(s, 8297000 + i * 100));
  // forged: seat 0's signature over 8297000 presented as 8299999
  assert.match(stands([{ ...good[0], priceCents: 8299999 }, ...good.slice(1)]).why, /does not verify/);
  // a v4 signature (over the proposed sample) is no reading
  assert.match(stands([{ ...good[0], signature: schnorr.sign(priceSampleId({ roundId, tick, priceCents: 8297000 }), seats[0].sk) }, ...good.slice(1)]).why, /does not verify/);
  // signed for another tick, or another round
  assert.match(stands([read(seats[0], 8297000, tick + 1), ...good.slice(1)]).why, /does not verify/);
  assert.match(priceSampleStands5({ roundId: b32(8), tick, readings: good, committee, threshold: 5, verify }).why, /does not verify/);
  // one key twice - even with two honest-looking prices - and a sixth reading does not make up for it
  assert.match(stands([...good, read(seats[0], 8297050)]).why, /two readings of the sample at tick 300 are signed by one key/);
  // a key outside the committee
  const stranger = (() => { const sk = b32(99); return { sk, pk: schnorr.getPublicKey(sk) }; })();
  assert.match(stands([...good.slice(0, 4), read(stranger, 8297000)]).why, /not a key of the round's committee/);
  // four is not five
  assert.match(stands(good.slice(0, 4)).why, /4 of the committee's readings, 5 are needed/);
  assert.match(stands([]).why, /0 of the committee's readings/);
  assert.match(stands(undefined).why, /carries its signed readings/);
  // hex works as bytes do
  const hex = good.map((r) => ({ key: Buffer.from(r.key).toString('hex'), priceCents: r.priceCents, signature: Buffer.from(r.signature).toString('hex') }));
  assert.equal(stands(hex).priceCents, 8297200);
});

test('the tape: each seat signs its own 64 readings once; each position is the median of that position over five or more tapes', () => {
  const tapeOf = (i) => Array.from({ length: PRICE_TAPE_LENGTH }, (_, j) => 8290000 + j * 10 + i * (i === 6 ? 100000 : 1));
  const signed = (s, prices) => ({ key: s.pk, prices, signature: schnorr.sign(priceTapeReadingId({ roundId, tick: 0, prices }), s.sk) });
  const all = seats.map((s, i) => signed(s, tapeOf(i)));
  const t = priceTapeStands5({ roundId, tapes: all, committee, threshold: 5, verify });
  assert.equal(t.ok, true, t.why);
  assert.deepEqual(t.prices, Array.from({ length: 64 }, (_, j) => 8290000 + j * 10 + 3), 'the fourth of seven at every position; seat 6 far off moves none');
  assert.equal(priceTapeStands5({ roundId, tapes: all.slice(0, 6), committee, threshold: 5, verify }).prices[0], 8290002, 'six: the lower middle');
  assert.match(priceTapeStands5({ roundId, tapes: all.slice(0, 4), committee, threshold: 5, verify }).why, /4 of the committee's readings/);
  const forged = { ...all[0], prices: [...all[0].prices.slice(0, 63), 1] };
  assert.match(priceTapeStands5({ roundId, tapes: [forged, ...all.slice(1)], committee, threshold: 5, verify }).why, /does not verify/);
});

// what a protocol-5 round's batch carries: the median and the readings, through the batch's own bytes
function v5Batch({ readings, cents, played = cents, tape = null }) {
  const b = { roundId, entryId: b32(2), previousHash: b32(3), firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [],
    samples: [[tick, centsToTapeUnits(played)]], tapes: tape ? [[0, ...tape.prices.map(centsToTapeUnits)]] : [],
    attests: [[tick, 2, cents, readings.map((r) => [r.key, r.priceCents, r.signature])], ...(tape ? [[0, 3, tape.prices, tape.readings.map((r) => [r.key, r.prices, r.signature])]] : [])] };
  return decodeInputBatch(encodeInputBatch(b));
}

test('a batch of a protocol-5 round: its sample stands as the median of its readings and must be played at that price; a proposed price is refused', () => {
  const rs = seats.map((s, i) => read(s, [8297400, 8297000, 8297300, 8297100, 8297200, 8297600, 8297500][i]));
  const check = (batch, median = true, require = true) => checkBatchPrices({ batch, roundId, committee, threshold: 5, verify, require, median });
  assert.deepEqual(check(v5Batch({ readings: rs, cents: 8297300 })), { ok: true, attested: 1 });
  // the stated price must BE the median: a player (or a seat) naming another is refused
  assert.match(check(v5Batch({ readings: rs, cents: 8297400 })).why, /names 8297400 cents; the median of its readings is 8297300/);
  // played at another price than the median
  assert.match(check(v5Batch({ readings: rs, cents: 8297300, played: 8297400 })).why, /not the attested 8297300 cents/);
  // a forged reading in the batch
  assert.match(check(v5Batch({ readings: [{ ...rs[0], priceCents: 8297001 }, ...rs.slice(1)], cents: 8297300 })).why, /does not stand: the reading .* does not verify/);
  // fewer than five
  assert.match(check(v5Batch({ readings: rs.slice(0, 4), cents: 8297200 })).why, /does not stand: 4 of the committee's readings/);
  // one round, one scheme: a v5 round refuses a proposed-and-countersigned sample, a v4 round refuses readings
  const id = priceSampleId({ roundId, tick, priceCents: 8297300 });
  const v4 = { samples: [[tick, centsToTapeUnits(8297300)]], tapes: [], attests: [[tick, 0, 8297300, seats.map((s) => [s.pk, schnorr.sign(id, s.sk)])]] };
  assert.match(check(v4).why, /a price one seat proposed: a round of protocol 5 plays the median/);
  assert.deepEqual(check(v4, false), { ok: true, attested: 1 }, 'the same batch stands in a round below 5, as it always did');
  assert.match(check(v5Batch({ readings: rs, cents: 8297300 }), false).why, /a median of signed readings, a protocol 5 price/);
  // and a bare sample is still refused where the feed is required
  assert.match(check({ samples: [[tick, 1]], tapes: [] }).why, /without the committee's attestation/);
  // the tape (kind 3) beside it
  const tapes = seats.slice(0, 5).map((s, i) => { const prices = Array.from({ length: 64 }, (_, j) => 8290000 + j + i); return { key: s.pk, prices, signature: schnorr.sign(priceTapeReadingId({ roundId, tick: 0, prices }), s.sk) }; });
  const medians = Array.from({ length: 64 }, (_, j) => 8290000 + j + 2);
  assert.deepEqual(check(v5Batch({ readings: rs, cents: 8297300, tape: { prices: medians, readings: tapes } })), { ok: true, attested: 2 });
  assert.match(check(v5Batch({ readings: rs, cents: 8297300, tape: { prices: medians.map((p) => p + 1), readings: tapes } })).why, /tape at tick 0 is not the median of its readings/);
});

test('RoundResult from medians: open and close are the medians of the two ends\' readings - BULLS, BEARS, FLAT - and an end below five stands nothing', () => {
  const endTick = 10800;
  const end = (t, prices) => ({ tick: t, readings: seats.map((s, i) => read(s, prices[i], t)) });
  const opened = end(0, [8297000, 8297100, 8296900, 8297050, 8297000, 1, 999999999]);           // median 8297000
  const closed = end(9000, [8297200, 8297300, 8297250, 8297100, 8297400, 999999999, 999999999]);  // median 8297300
  const r = roundResultFromReadings({ roundId, open: opened, close: closed, endTick, committee, threshold: 5, verify });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.result.openCents, r.result.closeCents, frontName(r.result.front), r.readings], [8297000, 8297300, 'BULLS', { open: 7, close: 7 }]);
  const flat = roundResultFromReadings({ roundId, open: opened, close: end(9000, [8297000, 8297000, 8297000, 8296000, 8298000, 1, 1]), endTick, committee, threshold: 5, verify });
  assert.deepEqual([flat.result.closeCents, frontName(flat.result.front)], [8297000, 'FLAT'], 'two liars far low: the median is still an honest 8297000');
  const bears = roundResultFromReadings({ roundId, open: opened, close: end(9000, [8296000, 8296100, 8296200, 8296300, 8296400, 8296500, 8296600]), endTick, committee, threshold: 5, verify });
  assert.deepEqual([bears.result.closeCents, frontName(bears.result.front)], [8296300, 'BEARS']);
  const short = { tick: 9000, readings: closed.readings.slice(0, 4) };
  assert.match(roundResultFromReadings({ roundId, open: opened, close: short, endTick, committee, threshold: 5, verify }).why, /the closing sample does not stand: 4 of the committee's readings/);
  // a stated close is never read: only the readings are
  assert.match(roundResultFromReadings({ roundId, open: opened, close: { ...closed, readings: closed.readings.map((x, i) => (i ? x : { ...x, priceCents: 8400000 })) }, endTick, committee, threshold: 5, verify }).why, /does not verify/);
});
