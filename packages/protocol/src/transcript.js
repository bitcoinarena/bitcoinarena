// A round's transcript: the object a node hands over and a verifier replays.
//
// §11 chains the batches and §13C says the canonical transcript is what every
// node replays, so it has to be ONE thing with ONE hash - not a table a
// verifier queries and hopes it asked for everything. This is that thing:
// the round, the entry, and the batches in chain order.
//
// Checkpoints belong in it later (§13C names them first), and they are M2.1
// step 3. Their absence here is why `transcriptHash` covers the inputs only,
// and it is stated rather than left to be discovered.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_TRANSCRIPT, TAG } from './constants.js';
import { encodeInputBatch, decodeInputBatch, batchId, batchTicks } from './batch.js';

export const GENESIS = new Uint8Array(32);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function encodeTranscript(t) {
  const w = new Writer();
  w.u8(TYPE_TRANSCRIPT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(t.roundId);
  w.bytes32(t.entryId);
  w.vec(t.batches, (b, ww) => {
    const bytes = encodeInputBatch(b);
    ww.u16(bytes.length);
    ww.bytes(bytes, bytes.length);
  });
  return w.finish();
}

export function decodeTranscript(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_TRANSCRIPT) throw new Error('not a transcript');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const t = { roundId: r.bytes32(), entryId: r.bytes32() };
  t.batches = r.vec((rr) => decodeInputBatch(rr.bytes(rr.u16())));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the transcript');
  return t;
}

export const transcriptHash = (t) => taggedHash(TAG.transcript, encodeTranscript(t));

/**
 * Checks the chain and the tick order, and says WHERE it broke rather than
 * that it broke. A verifier that only learns "invalid" has to bisect by hand.
 *
 * Returns `{ ok: true, ticks }` or `{ ok: false, at, why }`.
 */
export function checkTranscript(t) {
  let previous = GENESIS;
  let expect = null;
  let ticks = 0;
  for (let i = 0; i < t.batches.length; i++) {
    const b = t.batches[i];
    if (!same(b.roundId, t.roundId)) return { ok: false, at: i, why: 'batch is for another round' };
    if (!same(b.entryId, t.entryId)) return { ok: false, at: i, why: 'batch is for another entry' };
    if (!same(b.previousHash, previous)) return { ok: false, at: i, why: 'the chain is broken here' };
    const at = batchTicks(b);
    if (expect !== null && at[0] !== expect)
      return { ok: false, at: i, why: `expected tick ${expect}, got ${at[0]}` };
    expect = at.length ? at[at.length - 1] + 1 : expect;
    ticks += at.length;
    previous = batchId(b);
  }
  return { ok: true, ticks };
}

/**
 * The inputs a replay needs, flattened: one row of five words per tick in
 * tick order, and the liquidations gathered from every batch.
 *
 * Not a convenience - it is the boundary. A verifier gets exactly what the
 * core's `step` and `submitLiquidation` take and nothing else, so there is no
 * second interpretation of a transcript anywhere.
 *
 * THE LIQUIDATION TICKS ARE REBASED to an index into `ticks`, and that is the
 * whole reason this function exists rather than a caller reading the batches.
 * On the wire they are absolute, because absolute is what makes a repeat
 * harmless; a replay walks the array from zero. A transcript that begins at
 * tick 50 would otherwise put a strike at index 51 of a two-element array -
 * that is, nowhere - and the replay would be a different round with nothing
 * to say it had gone wrong. `firstTick` is returned beside them so a caller
 * can still say where the round began.
 */
export function flatten(t) {
  const ticks = [];
  const liquidations = [];
  for (const b of t.batches) {
    for (const row of b.ticks) ticks.push(row);
    for (const l of b.liquidations) liquidations.push(l);
  }
  const firstTick = t.batches.length ? t.batches[0].firstTick : 0;
  liquidations.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  return {
    firstTick,
    ticks,
    liquidations: liquidations.map(([at, size]) => [at - firstTick, size]),
  };
}
