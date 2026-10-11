// THE PRICE A RUN PLAYS AGAINST, SIGNED BY THE COMMITTEE (§11, kanban #311). "PriceSample { tick, price_cents, attestation }
// ... `attestation` is the game/verify committee's signature over (round_id, tick, price_cents): the committee nodes publish
// one attested sample every 5 s of round time from the contract's named feed - and, with the first, the 64 samples before
// start_time from the feed's history ... The player never chooses the price."
//
// DECIDED HERE (the spec names the fields, not the bytes): each seat signs the sample's id with its node key (BIP-340), and
// an attestation is the list of those signatures - it stands when at least `threshold` distinct keys of the round's
// committee signed it. The 64 prices before the start are one PriceTape object under its own tag, signed the same way.
// The signatures sit BESIDE the object, as for a checkpoint receipt, so an id never changes when it is signed.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_PRICE_SAMPLE, TYPE_PRICE_TAPE, TAG } from './constants.js';
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
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
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

/** Sample k of a run (k = 0, 1, ... every 5 s of round time) is applied at this tick - the network's tick rate (tick.js). */
export const sampleTick = (k) => Number(ticksForMs(BigInt(k) * BigInt(PRICE_SAMPLE_EVERY_MS)).ticks);

/** The tape's unit is 256 a dollar (batch.js); a signed price is in cents. One rule, rounded half up, on both sides. */
export const centsToTapeUnits = (c) => Math.floor((c * 256 + 50) / 100);

/**
 * THE PRICES A BATCH PLAYED, CHECKED AGAINST THE COMMITTEE'S SIGNATURES (§11, kanban #311): every attestation the batch
 * carries must stand (`priceAttestationStands`) for this round, and the sample (or the tape) at its tick must be its price in
 * the tape's unit. `require`: also refuse a sample or a tape that carries no attestation (a round whose contract names a
 * feed - slice 3). Answers { ok, attested: n } or { ok: false, why }.
 */
export function checkBatchPrices({ batch, roundId, committee, threshold, verify, require = false }) {
  const attests = batch.attests || [];
  const at = (list, tick) => (list || []).filter((x) => x[0] === tick);
  for (const [tick, kind, cents, sigs] of attests) {
    const id = kind === 0 ? priceSampleId({ roundId, tick, priceCents: cents }) : priceTapeId({ roundId, tick, prices: cents });
    const s = priceAttestationStands({ id, sigs: sigs.map(([key, signature]) => ({ key, signature })), committee, threshold, verify });
    if (!s.ok) return { ok: false, why: `the ${kind === 0 ? 'sample' : 'tape'} at tick ${tick} is not attested: ${s.why}` };
    if (kind === 0) {
      const played = at(batch.samples, tick);
      if (played.length !== 1 || played[0][1] !== centsToTapeUnits(cents))
        return { ok: false, why: `the sample at tick ${tick} is not the attested ${cents} cents (${centsToTapeUnits(cents)} in the tape's unit)` };
    } else {
      const played = at(batch.tapes, tick);
      if (played.length !== 1 || played[0].slice(1).some((p, i) => p !== centsToTapeUnits(cents[i])))
        return { ok: false, why: `the tape at tick ${tick} is not the attested tape` };
    }
  }
  if (require) {
    const has = (kind, tick) => attests.some((a) => a[1] === kind && a[0] === tick);
    const bare = (batch.samples || []).find((x) => !has(0, x[0])) ? 'sample' : (batch.tapes || []).find((x) => !has(1, x[0])) ? 'tape' : null;
    if (bare) return { ok: false, why: `a ${bare} without the committee's attestation: the player never chooses the price (§11)` };
  }
  return { ok: true, attested: attests.length };
}
