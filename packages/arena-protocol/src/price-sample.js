// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PRICE A RUN PLAYS AGAINST, SIGNED BY THE COMMITTEE (§11). "PriceSample { tick, price_cents, attestation }
// ... `attestation` is the game/verify committee's signature over (round_id, tick, price_cents): the committee nodes publish
// one attested sample every 5 s of round time from the contract's named feed - and, with the first, the 64 samples before
// start_time from the feed's history ... The player never chooses the price."
//
// DECIDED HERE (the spec names the fields, not the bytes): each seat signs the sample's id with its node key (BIP-340), and
// an attestation is the list of those signatures - it stands when at least `threshold` distinct keys of the round's
// committee signed it. The 64 prices before the start are one PriceTape object under its own tag, signed the same way.
// The signatures sit BESIDE the object, as for a checkpoint receipt, so an id never changes when it is signed.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_PRICE_SAMPLE, TYPE_PRICE_TAPE, TAG } from './constants.js';
import { ticksForMs } from './tick.js';

/** One sample every 5 s of round time (§11); the tape before the start is 64 of them. */
export const PRICE_SAMPLE_EVERY_MS = 5000;
export const PRICE_TAPE_LENGTH = 64;

const isBytes32 = (b) => b instanceof Uint8Array && b.length === 32;
const cents = (p) => { if (!Number.isInteger(p) || p <= 0 || p > 0x7fffffff) throw new Error('a price is a whole, positive number of cents'); return p; };

export function encodePriceSample({ roundId, tick, priceCents }) {
  if (!isBytes32(roundId)) throw new Error('a price sample names its 32-byte round');
  const w = new Writer();
  w.u8(TYPE_PRICE_SAMPLE); w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId); w.u32(tick); w.i32(cents(priceCents));
  return w.finish();
}
export function decodePriceSample(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_PRICE_SAMPLE) throw new Error('not a price sample');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const s = { roundId: r.bytes32(), tick: r.u32(), priceCents: r.i32() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the price sample');
  return s;
}
export const priceSampleId = (s) => taggedHash(TAG.priceSample, encodePriceSample(s));

/** The 64 prices before the start (§11), oldest first, as the run's first batch carries them at `tick`. */
export function encodePriceTape({ roundId, tick, prices }) {
  if (!isBytes32(roundId)) throw new Error('a price tape names its 32-byte round');
  if (!Array.isArray(prices) || prices.length !== PRICE_TAPE_LENGTH) throw new Error(`a price tape is ${PRICE_TAPE_LENGTH} prices`);
  const w = new Writer();
  w.u8(TYPE_PRICE_TAPE); w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId); w.u32(tick);
  for (const p of prices) w.i32(cents(p));
  return w.finish();
}
export const priceTapeId = (t) => taggedHash(TAG.priceTape, encodePriceTape(t));

/**
 * AN ATTESTATION STANDS when at least `threshold` distinct keys of `committee` (x-only, 32 bytes each) signed `id`.
 * `sigs`: [{ key, signature }] (Uint8Array or hex); `verify(signature, message, key)` is BIP-340, injected as everywhere.
 * Answers { ok, signed: [keys that verified], why }. A key outside the committee, a second signature by one key, or a
 * signature that does not verify counts nothing - it never refuses the others.
 */
export function priceAttestationStands({ id, sigs, committee, threshold, verify }) {
  if (!isBytes32(id)) return { ok: false, signed: [], why: 'no 32-byte id to check' };
  if (!Number.isInteger(threshold) || threshold < 1) return { ok: false, signed: [], why: 'no threshold' };
  if (typeof verify !== 'function') return { ok: false, signed: [], why: 'checking a signature needs a verifier, and none was injected' };
  const members = new Set((committee || []).map((k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k))));
  const signed = new Set();
  for (const s of sigs || []) {
    const key = typeof s.key === 'string' ? s.key.toLowerCase() : toHex(s.key);
    if (!members.has(key) || signed.has(key)) continue;
    const sig = typeof s.signature === 'string' ? Uint8Array.from(s.signature.match(/../g).map((x) => parseInt(x, 16))) : s.signature;
    const pk = Uint8Array.from(key.match(/../g).map((x) => parseInt(x, 16)));
    let good = false;
    try { good = !!verify(sig, id, pk); } catch { good = false; }
    if (good) signed.add(key);
  }
  return signed.size >= threshold ? { ok: true, signed: [...signed] }
    : { ok: false, signed: [...signed], why: `${signed.size} of the committee signed it, ${threshold} are needed` };
}

// ---------------------------------------------------------------------------------------------------------------------------
// PROTOCOL 5: THE MEDIAN OF SIGNED READINGS (RULED 2026-10-14 ~21:50Z: "Build A as protocol 5 ... each seat
// signs the price it read, and the sample is the median of five signed readings. Nobody proposes a price, so nobody chooses
// BULLS, BEARS, or FLAT."). Measured before it: rounds 6b51be20 / a45f2ae5 were signed FLAT by 7 seats with both ends at
// $81,766.45 while the run traded $81,713-81,838 - the proposing seat's price, which the others signed within a tolerance.
//
// DECIDED HERE:
//   A READING is one seat's own price for one moment: priceReadingId = taggedHash(PriceReading, round_id || u32 tick || i32
//     cents), BIP-340 with that seat's node key. A seat signs only its own reading; nobody signs anyone else's price.
//   A SAMPLE (protocol 5) is a tick and at least `threshold` readings by DISTINCT keys of the round's committee; its price is
//     the MEDIAN of all the readings it carries: sorted ascending, an odd count the middle one, an even count the LOWER middle
//     (a reading somebody actually signed - never an average no seat read). priceSampleStands5 verifies every signature, the
//     keys and the count and recomputes the median: a stated price is never trusted. A forged reading, a second reading by one
//     key or a key outside the committee refuses the sample (it is not quietly dropped): the readings a sample carries are
//     exactly the ones its price is the median of.
//   THE TAPE (the 64 prices before the start): each seat signs ITS WHOLE TAPE once - taggedHash(PriceTapeReading, round_id ||
//     u32 tick || 64 x i32 cents), its own readings of the 64 moments - and the tape's price at each position is the median of
//     that position over at least `threshold` such tapes (priceTapeStands5). One signature a seat instead of 64: a tape of seven
//     seats is 7 x 352 bytes in a batch, where 64 signed moments a seat would be 7 x 64 x 100 = 44.8 kB - most of a batch -
//     for the same check. A seat that did not read every moment signs no tape (it fills no gap with an older price, as the
//     interim's C), so every position of a standing tape is the median of the same >= threshold seats.
//   AN OUTLIER CANNOT MOVE IT: with at most n - threshold (2 of 7) seats lying, the median of >= threshold (5) readings has at
//     least two honest readings at or above it and at or below it - it lies within the honest seats' range.
//   WHAT IS LEFT: whoever assembles a sample from more than `threshold` readings may leave some out; the median of any 5 of 7
//     is still one of the middle readings (the 3rd to 5th of the seven), all within the honest range. A seat's RoundResult takes
//     every reading of the committee it holds or can fetch (price-feed.js), so the seats agree on the same set.
// ---------------------------------------------------------------------------------------------------------------------------

export function encodePriceReading({ roundId, tick, priceCents }) {
  if (!isBytes32(roundId)) throw new Error('a price reading names its 32-byte round');
  const w = new Writer();
  w.bytes32(roundId); w.u32(tick); w.i32(cents(priceCents));
  return w.finish();
}
export const priceReadingId = (x) => taggedHash(TAG.priceReading, encodePriceReading(x));

export function encodePriceTapeReading({ roundId, tick, prices }) {
  if (!isBytes32(roundId)) throw new Error('a tape reading names its 32-byte round');
  if (!Array.isArray(prices) || prices.length !== PRICE_TAPE_LENGTH) throw new Error(`a tape reading is ${PRICE_TAPE_LENGTH} prices`);
  const w = new Writer();
  w.bytes32(roundId); w.u32(tick);
  for (const p of prices) w.i32(cents(p));
  return w.finish();
}
export const priceTapeReadingId = (x) => taggedHash(TAG.priceTapeReading, encodePriceTapeReading(x));

/** THE MEDIAN (protocol 5): sorted ascending, an odd count the middle one, an even count the lower middle. */
export function medianOf(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('the median of nothing');
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

const readingKeyHex = (k) => (typeof k === 'string' ? k.toLowerCase() : k instanceof Uint8Array ? toHex(k) : '');
const readingBytes = (x) => (typeof x === 'string' ? (/^([0-9a-f]{2})*$/i.test(x) ? fromHex(x.toLowerCase()) : new Uint8Array(0)) : x instanceof Uint8Array ? x : new Uint8Array(0));

// the signed readings of one sample or tape, checked one by one: every one is the committee's, by a key not seen before in it,
// and verifies - or the whole is refused, by name
function readingsStand({ list, idOf, committee, threshold, verify, what }) {
  if (!Number.isInteger(threshold) || threshold < 1) return { ok: false, why: 'no threshold' };
  if (typeof verify !== 'function') return { ok: false, why: 'checking a signature needs a verifier, and none was injected' };
  if (!Array.isArray(list)) return { ok: false, why: `a ${what} carries its signed readings` };
  const members = new Set((committee || []).map(readingKeyHex));
  const seen = new Set();
  for (const x of list) {
    const key = readingKeyHex(x && x.key);
    if (!/^[0-9a-f]{64}$/.test(key)) return { ok: false, why: `a reading of the ${what} names no 32-byte key` };
    if (!members.has(key)) return { ok: false, why: `a reading of the ${what} is signed by ${key.slice(0, 16)}, not a key of the round's committee` };
    if (seen.has(key)) return { ok: false, why: `two readings of the ${what} are signed by one key, ${key.slice(0, 16)}: a seat reads once` };
    let id; try { id = idOf(x); } catch (e) { return { ok: false, why: `a reading of the ${what} by ${key.slice(0, 16)}: ${e.message}` }; }
    const sig = readingBytes(x.signature);
    let good = false;
    try { good = sig.length === 64 && !!verify(sig, id, fromHex(key)); } catch { good = false; }
    if (!good) return { ok: false, why: `the reading of the ${what} by ${key.slice(0, 16)} does not verify` };
    seen.add(key);
  }
  if (seen.size < threshold) return { ok: false, why: `${seen.size} of the committee's readings, ${threshold} are needed` };
  return { ok: true, signed: [...seen] };
}

/**
 * A PROTOCOL-5 SAMPLE STANDS when it carries at least `threshold` readings (`readings`: [{ key, priceCents, signature }], hex
 * or bytes) of `tick`, each signed by its own distinct key of `committee`. Answers { ok, priceCents (their median), count,
 * signed } or { ok: false, why }. It never takes a price it is told: the price is the median it computes.
 */
export function priceSampleStands5({ roundId, tick, readings, committee, threshold, verify }) {
  if (!isBytes32(roundId)) return { ok: false, why: 'no 32-byte round to check' };
  if (!Number.isInteger(tick) || tick < 0) return { ok: false, why: 'a sample names its tick' };
  const s = readingsStand({ list: readings, idOf: (x) => priceReadingId({ roundId, tick, priceCents: x.priceCents }), committee, threshold, verify, what: `sample at tick ${tick}` });
  if (!s.ok) return s;
  return { ok: true, priceCents: medianOf(readings.map((x) => x.priceCents)), count: readings.length, signed: s.signed };
}

/**
 * A PROTOCOL-5 TAPE STANDS when it carries at least `threshold` whole tapes (`tapes`: [{ key, prices (64 cents), signature }])
 * by distinct keys of `committee`; its price at each position is the median of that position. Answers { ok, prices, count,
 * signed } or { ok: false, why }.
 */
export function priceTapeStands5({ roundId, tick = 0, tapes, committee, threshold, verify }) {
  if (!isBytes32(roundId)) return { ok: false, why: 'no 32-byte round to check' };
  const s = readingsStand({ list: tapes, idOf: (x) => priceTapeReadingId({ roundId, tick, prices: x.prices }), committee, threshold, verify, what: 'tape' });
  if (!s.ok) return s;
  const prices = Array.from({ length: PRICE_TAPE_LENGTH }, (_, i) => medianOf(tapes.map((x) => x.prices[i])));
  return { ok: true, prices, count: tapes.length, signed: s.signed };
}

/** Sample k of a run (k = 0, 1, ... every 5 s of round time) is applied at this tick - the network's tick rate (tick.js). */
export const sampleTick = (k) => Number(ticksForMs(BigInt(k) * BigInt(PRICE_SAMPLE_EVERY_MS)).ticks);

/** The tape's unit is 256 a dollar (batch.js); a signed price is in cents. One rule, rounded half up, on both sides. */
export const centsToTapeUnits = (c) => Math.floor((c * 256 + 50) / 100);

/**
 * THE PRICES A BATCH PLAYED, CHECKED AGAINST THE COMMITTEE'S SIGNATURES (§11): every attestation the batch
 * carries must stand (`priceAttestationStands`) for this round, and the sample (or the tape) at its tick must be its price in
 * the tape's unit. `require`: also refuse a sample or a tape that carries no attestation (a round whose contract names a
 * feed - slice 3). Answers { ok, attested: n } or { ok: false, why }.
 *
 * `median` (protocol 5, - the ROUND's version says it, constants.js mediansPrices): the batch's prices are kind 2
 * samples [tick, 2, cents, [[key, cents, sig]]] and a kind 3 tape [tick, 3, prices, [[key, prices, sig]]] - the seats' own
 * signed readings - and each stands by priceSampleStands5 / priceTapeStands5, its stated price only when it IS the median of
 * them. A round of protocol 5 refuses a proposed-and-countersigned price (kinds 0 and 1), and a round below it refuses the
 * readings (kinds 2 and 3): one round, one scheme. Without `median` this is the check it always was.
 */
export function checkBatchPrices({ batch, roundId, committee, threshold, verify, require = false, median = false }) {
  const attests = batch.attests || [];
  const at = (list, tick) => (list || []).filter((x) => x[0] === tick);
  const isTape = (kind) => kind === 1 || kind === 3;
  for (const [tick, kind, cents, sigs] of attests) {
    if ((kind === 2 || kind === 3) !== !!median)
      return { ok: false, why: median ? `the ${isTape(kind) ? 'tape' : 'sample'} at tick ${tick} is a price one seat proposed: a round of protocol 5 plays the median of the committee's own signed readings`
        : `the ${isTape(kind) ? 'tape' : 'sample'} at tick ${tick} is a median of signed readings, a protocol 5 price: this round plays the committee's attested prices` };
    let prices;   // what the batch must have played at that tick, in cents
    if (kind === 2 || kind === 3) {
      const s = kind === 2
        ? priceSampleStands5({ roundId, tick, readings: (sigs || []).map(([key, priceCents, signature]) => ({ key, priceCents, signature })), committee, threshold, verify })
        : priceTapeStands5({ roundId, tick, tapes: (sigs || []).map(([key, ps, signature]) => ({ key, prices: ps, signature })), committee, threshold, verify });
      if (!s.ok) return { ok: false, why: `the ${kind === 2 ? 'sample' : 'tape'} at tick ${tick} does not stand: ${s.why}` };
      if (kind === 2 ? s.priceCents !== cents : !Array.isArray(cents) || cents.some((p, i) => p !== s.prices[i]))
        return { ok: false, why: `the ${kind === 2 ? `sample at tick ${tick} names ${cents} cents; the median of its readings is ${s.priceCents}` : `tape at tick ${tick} is not the median of its readings`}` };
      prices = kind === 2 ? s.priceCents : s.prices;
    } else {
      const id = kind === 0 ? priceSampleId({ roundId, tick, priceCents: cents }) : priceTapeId({ roundId, tick, prices: cents });
      const s = priceAttestationStands({ id, sigs: sigs.map(([key, signature]) => ({ key, signature })), committee, threshold, verify });
      if (!s.ok) return { ok: false, why: `the ${kind === 0 ? 'sample' : 'tape'} at tick ${tick} is not attested: ${s.why}` };
      prices = cents;
    }
    if (!isTape(kind)) {
      const played = at(batch.samples, tick);
      if (played.length !== 1 || played[0][1] !== centsToTapeUnits(prices))
        return { ok: false, why: `the sample at tick ${tick} is not the attested ${prices} cents (${centsToTapeUnits(prices)} in the tape's unit)` };
    } else {
      const played = at(batch.tapes, tick);
      if (played.length !== 1 || played[0].slice(1).some((p, i) => p !== centsToTapeUnits(prices[i])))
        return { ok: false, why: `the tape at tick ${tick} is not the attested tape` };
    }
  }
  if (require) {
    const has = (tape, tick) => attests.some((a) => isTape(a[1]) === tape && a[0] === tick);
    const bare = (batch.samples || []).find((x) => !has(false, x[0])) ? 'sample' : (batch.tapes || []).find((x) => !has(true, x[0])) ? 'tape' : null;
    if (bare) return { ok: false, why: `a ${bare} without the committee's attestation: the player never chooses the price (§11)` };
  }
  return { ok: true, attested: attests.length };
}
