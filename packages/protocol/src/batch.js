// An input batch: what a player sends while a round is running.
//
// THE SHAPE IS THE CORE'S, not a new one. `packages/core`'s `step` takes
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
import { PROTOCOL_VERSION, TYPE_INPUT_BATCH, TAG } from './constants.js';

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
  return w.finish();
}

export function decodeInputBatch(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_INPUT_BATCH) throw new Error('not an input batch');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
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

/** Header, then five signed words a tick and eight bytes a liquidation. */
const BATCH_HEADER_BYTES = 1 + 2 + 32 + 32 + 32 + 4;

/**
 * The largest batch that can decode at all: header, the tick vector at its
 * ceiling, the liquidation vector at its ceiling. Measured against the
 * encoder rather than reasoned about - a test builds one and compares.
 *
 * This is what a transport can refuse without inspecting: anything longer is
 * not a short protocol message, it is not a protocol message.
 */
export const MAX_INPUT_BATCH_BYTES =
  BATCH_HEADER_BYTES + 2 + MAX_BATCH_TICKS * 20 + 2 + MAX_BATCH_TICKS * 8;

/** The absolute tick numbers a batch covers, in order. */
export const batchTicks = (b) =>
  Array.from({ length: b.ticks.length }, (_, i) => b.firstTick + i);
