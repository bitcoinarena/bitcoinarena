// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// An input batch: what a player sends while a round is running.
//
// THE SHAPE IS THE CORE'S, not a new one. `packages/nextblock`'s `step` takes
// throttle, steer, brake, handbrake and practice, in that order, and the
// golden vectors record exactly those five per tick. A batch carries the same
// five in the same order, so a node's transcript and a golden vector are the
// same list of numbers and a round can be replayed by handing them to `step`
// unchanged.
//
// AND THE LIQUIDATIONS, which the five do not carry. A liquidation reaches the
// core through `submitLiquidation` between ticks, not through `step`, so a
// transcript with only the five would replay a round with no strike, no
// crater and no fallout in it - a different game from the one that was
// played. They are sparse because they are rare: `[tick, size]`, the same
// shape `test-vectors/*.json` uses.
//
// AND THE LOAD, which the five do not carry either. What went on the bed
// decides how hard the war hunts the truck, and it used to be a HOST WRITE:
// Unity worked the wanted level out in floats and pushed the answer through
// `BlwpSetHeat`, which is in no batch, no mark and no transcript. The page's
// core carried 57229 and every replay of the same transcript carried 0, so a
// committee - and every ghost a committee draws - walked a run the war was
// hunting less hard than it hunted the player. `[tick, feeSats,
// btcHundredths]`, sparse like the liquidations, because a load is declared
// at roll-out and rarely again; the core decides what it costs.
//
// AND THE PRICE SAMPLES (2026-09-17 16:01: the chart was frozen - nothing ever submitted one). The live
// BTCUSD price every 300 ticks moves the tape, the candles, the seam and the market the army reads, so a transcript
// without them replays a different war. `[tick, price]` (the tape's unit, 256 a dollar), sparse like the
// liquidations. Written only when there are any: a batch without samples is byte for byte the batch it was before,
// so every stored batch keeps its id.
//
// AND THEY ARE CHAINED. `previous_hash` is the spec's own field (section 11):
// each batch names the one before it, so a transcript is an ordered object
// rather than a bag of rows that happen to sit in a table. Without it, "hand
// me the transcript" means "hand me whatever you have and trust it is all of
// it"; with it, a missing or altered batch breaks the chain at a named place.
// The first batch of a round chains to thirty-two zero bytes.
//
// Ticks are absolute, not relative to the batch. A repeat is then harmless -
// the node writes the same tick number twice and keeps one - and a gap is
// visible, because the numbers themselves say what is missing. That is the
// property `M2.1` step 2 needs and it costs nothing to have from the start.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_INPUT_BATCH, TAG } from './constants.js';

/** The prices a live tape carries: the core's SAMPLES. */
export const TAPE_PRICES = 64;

/**
 * AND THE COMMITTEE'S SIGNATURES ON THEM (§11): `[tick, kind, cents, sigs]` - kind 0 the sample at that
 * tick (cents: its price), kind 1 the tape (cents: its 64 prices) - each sig `[key32, sig64]` of the round's committee
 * over priceSampleId / priceTapeId. A fourth optional tail after the rooms, written only when there is one: every batch
 * before it keeps its bytes and its id. One attested sample a tick (a batch held through a stall can cover several 5 s
 * samples) up to MAX_ATTESTED_SAMPLES, one tape, each with at most MAX_ATTEST_SIGS.
 *
 * PROTOCOL 5 (each seat signs its own reading, the price is their median - price-sample.js): kind 2 a sample
 * `[tick, 2, cents, [[key32, cents, sig64], ...]]` and kind 3 the tape `[tick, 3, prices, [[key32, prices, sig64], ...]]` -
 * the median and the seats' signed readings it is the median of, at most MAX_ATTEST_SIGS of them. Kinds 0 and 1 keep their
 * bytes; one sample a tick and one tape a batch count both kinds.
 */
export const MAX_ATTEST_SIGS = 9;
export const MAX_ATTESTED_SAMPLES = 256;
/** How many words of input a tick carries. The core's `step` arity. */
export const INPUT_WORDS = 5;

export function encodeInputBatch(b) {
  const w = new Writer();
  w.u8(TYPE_INPUT_BATCH);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(b.roundId);
  w.bytes32(b.entryId);
  w.bytes32(b.previousHash);
  w.u32(b.firstTick);

  // The ticks themselves, five signed words each. Q16.16, the units the core
  // takes; nothing is scaled at this boundary, which is where a rounding rule
  // could differ between two implementations.
  w.vec(b.ticks, (t, ww) => {
    if (t.length !== INPUT_WORDS) throw new Error('a tick carries five words');
    for (const v of t) ww.i32(v);
  });

  // `[tick, size]`, sorted and absolute. Sorted so two nodes that received
  // them in a different order still encode the same bytes.
  const liq = [...(b.liquidations || [])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  w.vec(liq, (l, ww) => { ww.u32(l[0]); ww.i32(l[1]); });

  // `[tick, feeSats, btcHundredths]`, sorted the same way and for the same
  // reason. Twelve bytes each and there is one of them in an ordinary run.
  const loads = [...(b.loads || [])].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  w.vec(loads, (l, ww) => { ww.u32(l[0]); ww.i32(l[1]); ww.i32(l[2]); });

  // `[tick, price]`, sorted; absent when empty (see the head of this file).
  const samples = [...(b.samples || [])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // THE LIVE TAPE (2026-09-17 16:44): `[tick, p0 .. p63]`, the 64 live prices a page handed its core before any
  // sample, in their own order (oldest first - not sorted inside). Absent when empty; when present the sample vector is
  // written before it even if empty, so the two optional tails read back unambiguously.
  const tapes = [...(b.tapes || [])].sort((x, y) => x[0] - y[0]);
  // one a batch at most: a run hands over one tape, and the transport ceiling stays a short message
  if (tapes.length > 1) throw new Error('a batch carries at most one tape');
  // THE ROOM A LOAD FILLS (2026-10-04 08:54: the cargo factor C is the bed fill): `[tick, room]` for each load
  // that carries a fourth word, the room its bed takes (cargo.js roomFor summed), so a replay sets the same C. A third
  // optional tail after the samples and the tape, written only when a load carries a room - so every batch before it,
  // and every load that carries none, is byte for byte what it was and keeps its id. The two tails before it are written
  // (empty) when this one is, so the three read back unambiguously.
  const rooms = loads.filter((l) => l.length > 3 && l[3] !== undefined && l[3] !== null).map((l) => [l[0], l[3] | 0]);
  if (new Set(rooms.map((r) => r[0])).size !== rooms.length) throw new Error('a batch carries one room a load tick');
  const attests = [...(b.attests || [])].sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  const sampleTicks = attests.filter((a) => a[1] === 0 || a[1] === 2).map((a) => a[0]);
  if (new Set(sampleTicks).size !== sampleTicks.length || sampleTicks.length > MAX_ATTESTED_SAMPLES || attests.filter((a) => a[1] === 1 || a[1] === 3).length > 1
    || attests.some((a) => a[1] !== 0 && a[1] !== 1 && a[1] !== 2 && a[1] !== 3))
    throw new Error(`a batch carries one attested sample a tick (at most ${MAX_ATTESTED_SAMPLES}) and at most one attested tape`);
  if (samples.length || tapes.length || rooms.length || attests.length) w.vec(samples, (l, ww) => { ww.u32(l[0]); ww.i32(l[1]); });
  if (tapes.length || rooms.length || attests.length) w.vec(tapes, (l, ww) => {
    if (l.length !== 1 + TAPE_PRICES) throw new Error(`a tape carries ${TAPE_PRICES} prices`);
    ww.u32(l[0]); for (let i = 1; i <= TAPE_PRICES; i++) ww.i32(l[i]);
  });
  if (rooms.length || attests.length) w.vec(rooms, (l, ww) => { ww.u32(l[0]); ww.i32(l[1]); });
  if (attests.length) w.vec(attests, (a, ww) => {
    const [tick, kind, cents, sigs] = a;
    const tapeOf = (ps) => { if (!Array.isArray(ps) || ps.length !== TAPE_PRICES) throw new Error(`an attested tape carries ${TAPE_PRICES} prices`); return ps; };
    ww.u32(tick); ww.u8(kind);
    if (kind === 0 || kind === 2) ww.i32(cents);
    else for (const c of tapeOf(cents)) ww.i32(c);
    if (!Array.isArray(sigs) || sigs.length > MAX_ATTEST_SIGS) throw new Error(`an attestation carries at most ${MAX_ATTEST_SIGS} signatures`);
    if (kind < 2) ww.vec(sigs, (sg, w3) => { w3.bytes32(sg[0]); w3.bytes(sg[1], 64); });
    // protocol 5: each reading its key, its own price(s) and its signature
    else ww.vec(sigs, (sg, w3) => { w3.bytes32(sg[0]); if (kind === 2) w3.i32(sg[1]); else for (const c of tapeOf(sg[1])) w3.i32(c); w3.bytes(sg[2], 64); });
  });
  return w.finish();
}

export function decodeInputBatch(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_INPUT_BATCH) throw new Error('not an input batch');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('unknown protocol version');
  const b = {
    roundId: r.bytes32(),
    entryId: r.bytes32(),
    previousHash: r.bytes32(),
    firstTick: r.u32(),
  };
  b.ticks = r.vec((rr) => {
    const t = [];
    for (let i = 0; i < INPUT_WORDS; i++) t.push(rr.i32());
    return t;
  });
  b.liquidations = r.vec((rr) => [rr.u32(), rr.i32()]);
  b.loads = r.vec((rr) => [rr.u32(), rr.i32(), rr.i32()]);
  // whatever follows the loads is a sample vector, then a tape vector, then a room vector, or nothing; bytes that do not
  // read as those are trailing bytes
  try {
    b.samples = r.at < bytes.length ? r.vec((rr) => [rr.u32(), rr.i32()]) : [];
    b.tapes = r.at < bytes.length ? r.vec((rr) => { const t = [rr.u32()]; for (let i = 0; i < TAPE_PRICES; i++) t.push(rr.i32()); return t; }) : [];
    var rooms = r.at < bytes.length ? r.vec((rr) => [rr.u32(), rr.i32()]) : [];
    b.attests = r.at < bytes.length ? r.vec((rr) => {
      const tick = rr.u32(); const kind = rr.u8();
      const tape = () => Array.from({ length: TAPE_PRICES }, () => rr.i32());
      const cents = kind === 0 || kind === 2 ? rr.i32() : kind === 1 || kind === 3 ? tape() : (() => { throw new Error('kind'); })();
      const sigs = kind < 2 ? rr.vec((r3) => [r3.bytes32(), r3.bytes(64)])
        : rr.vec((r3) => { const key = r3.bytes32(); const own = kind === 2 ? r3.i32() : Array.from({ length: TAPE_PRICES }, () => r3.i32()); return [key, own, r3.bytes(64)]; });
      if (sigs.length > MAX_ATTEST_SIGS) throw new Error('sigs');
      return [tick, kind, cents, sigs];
    }) : [];
  } catch { throw new Error('trailing bytes after the batch'); }
  if (!b.attests.length) delete b.attests;
  // each room joins the load at its tick; a room with no load there is not a batch this encoder writes
  for (const [at, room] of rooms) {
    const l = b.loads.filter((x) => x[0] === at);
    if (l.length !== 1 || l[0].length > 3) throw new Error('a room names no single load at its tick');
    l[0].push(room);
  }
  if (b.tapes.length > 1) throw new Error('a batch carries at most one tape');
  // one encoding per batch: empty optional tails are written as none
  if (r.at === bytes.length && bytes.length !== encodeInputBatch(b).length) throw new Error('an empty optional vector is not canonical');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the batch');
  return b;
}

export const batchId = (b) => taggedHash(TAG.inputBatch, encodeInputBatch(b));

/**
 * The most ticks a batch CAN carry, and it is not a policy: `Writer.vec`
 * writes a u16 length, so a batch with more than this cannot be encoded and a
 * frame claiming more cannot be decoded. The same ceiling holds the
 * liquidations.
 */
export const MAX_BATCH_TICKS = 0xffff;

/**
 * Header, then five signed words a tick, eight bytes a liquidation and twelve
 * a load.
 */
const BATCH_HEADER_BYTES = 1 + 2 + 32 + 32 + 32 + 4;

/**
 * The largest batch that can decode at all: header, the tick vector at its
 * ceiling, the liquidation vector at its ceiling, the load vector at its
 * ceiling. Measured against the encoder rather than reasoned about - a test
 * builds one and compares.
 *
 * This is what a transport can refuse without inspecting: anything longer is
 * not a short protocol message, it is not a protocol message.
 */
export const MAX_INPUT_BATCH_BYTES =
  BATCH_HEADER_BYTES + 2 + MAX_BATCH_TICKS * 20 + 2 + MAX_BATCH_TICKS * 8
  + 2 + MAX_BATCH_TICKS * 12 + 2 + MAX_BATCH_TICKS * 8 + 2 + (4 + 4 * TAPE_PRICES)
  // the rooms (a load's bed fill, 2026-10-04), one a load at most
  + 2 + MAX_BATCH_TICKS * 8
  // the attested sample and tape (§11): tick, kind, price(s), and up to MAX_ATTEST_SIGS (key, signature) each - at their
  // largest the protocol-5 kinds 2 and 3, whose readings also carry each seat's own price(s): 100 bytes a sample
  // reading (key, cents, signature), 352 a tape reading (key, 64 prices, signature)
  + 2 + MAX_ATTESTED_SAMPLES * (4 + 1 + 4 + 2 + MAX_ATTEST_SIGS * 100) + (4 + 1 + 4 * TAPE_PRICES + 2 + MAX_ATTEST_SIGS * (32 + 4 * TAPE_PRICES + 64));

/** The absolute tick numbers a batch covers, in order. */
export const batchTicks = (b) =>
  Array.from({ length: b.ticks.length }, (_, i) => b.firstTick + i);
