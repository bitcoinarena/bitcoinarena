// WHO WON A PRICE ROUND (spec §13 RoundResult, kanban #312): "Who won the round is decided once, by the price, at the round's
// end ... RoundResult { round_id, open_cents, close_cents (first and last attested sample of the round), front (BULLS if
// close > open, BEARS if lower, FLAT if equal), node_pubkey, signature (5-of-7 of the settlement committee) }". It is what
// every client shows as THE BULLS WIN / THE BEARS WIN, the same for every player; it moves no money and enters no score.
//
// DECIDED HERE (the spec names the fields, not the bytes): the front is one byte (1 BULLS, 2 BEARS, 3 FLAT) and must agree
// with open and close, or the object does not parse; each node signs the result's id with its node key (BIP-340) and the
// signatures sit BESIDE the object, as for a price sample (price-sample.js), so the id never changes when it is signed.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_ROUND_RESULT, TAG } from './constants.js';
import { priceAttestationStands } from './price-sample.js';

export const FRONT = Object.freeze({ BULLS: 1, BEARS: 2, FLAT: 3 });
const NAMES = Object.freeze({ 1: 'BULLS', 2: 'BEARS', 3: 'FLAT' });
export const frontName = (f) => NAMES[f] || null;

/** BULLS if close > open, BEARS if lower, FLAT if equal (§13). */
export function frontOf(openCents, closeCents) {
  for (const c of [openCents, closeCents]) if (!Number.isInteger(c) || c <= 0) throw new Error('a price is a whole, positive number of cents');
  return closeCents > openCents ? FRONT.BULLS : closeCents < openCents ? FRONT.BEARS : FRONT.FLAT;
}

export function encodeRoundResult({ roundId, openCents, closeCents, front }) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round result names its 32-byte round');
  const f = frontOf(openCents, closeCents);
  if (front !== undefined && front !== f) throw new Error(`a front of ${frontName(front) || front} does not follow from ${openCents} -> ${closeCents} cents`);
  const w = new Writer();
  w.u8(TYPE_ROUND_RESULT); w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId); w.i32(openCents); w.i32(closeCents); w.u8(f);
  return w.finish();
}
export function decodeRoundResult(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ROUND_RESULT) throw new Error('not a round result');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const x = { roundId: r.bytes32(), openCents: r.i32(), closeCents: r.i32(), front: r.u8() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the round result');
  encodeRoundResult(x);   // the front must follow from open and close
  return x;
}
export const roundResultId = (x) => taggedHash(TAG.roundResult, encodeRoundResult(x));

/**
 * THE RESULT A NODE MAKES FROM THE ATTESTED SAMPLES IT HOLDS: open is the first attested sample of the round, close the last
 * one at or before `endTick` (the round's last tick). `samples`: [{ tick, priceCents }] (attested - the caller holds only
 * those). Answers { ok, result } or why not.
 */
export function roundResultFrom({ roundId, samples, endTick }) {
  const inRound = (samples || []).filter((s) => s && Number.isInteger(s.tick) && s.tick >= 0 && s.tick <= endTick && Number.isInteger(s.priceCents) && s.priceCents > 0)
    .sort((a, b) => a.tick - b.tick);
  if (!inRound.length) return { ok: false, why: 'no attested sample of the round is held' };
  const openCents = inRound[0].priceCents, closeCents = inRound[inRound.length - 1].priceCents;
  return { ok: true, result: { roundId, openCents, closeCents, front: frontOf(openCents, closeCents) },
    openTick: inRound[0].tick, closeTick: inRound[inRound.length - 1].tick, samples: inRound.length };
}

/** A result stands when `threshold` distinct keys of the settlement `committee` signed its id (as an attested price does). */
export function roundResultStands({ result, sigs, committee, threshold, verify }) {
  let id; try { id = roundResultId(result); } catch (e) { return { ok: false, signed: [], why: e.message }; }
  return priceAttestationStands({ id, sigs, committee, threshold, verify });
}
