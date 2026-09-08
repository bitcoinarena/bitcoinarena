// TIME, IN THE ONLY UNIT THE SIMULATION HAS.
//
// The round contract measures a round in TIME - `startTimeMs`, `entryCloseMs`,
// `objectionWindowMs`, and section 6's `player_run_duration // T_run` with the
// worked example at "T_run: 3 minutes" - while the transcript, the
// checkpoints, the ghosts and `blockTicks` all count TICKS. Nothing converted
// between them, which is why the CLTV floor of 15 and the run length of 19 are
// both parked: "the round contract measures its length in TICKS and an HTLC in
// TIME, and the protocol defines no tick rate to convert between them."
//
// THE RATE IS NOT DECLARED HERE. It is imported from the core, which is the
// only thing entitled to say how long its own tick is: the tick is a property
// of the simulation binary, and `simCoreHash` is what a round signs to pin
// that binary. A literal in this file would be a second clock - one number in
// the thing that runs the round and another in the thing that pays for it -
// and two clocks that agree today agree only until one of them is edited. It
// is the same rule as the payout table: one implementation, and no argument
// through which a caller can supply a different one.
//
// This is the shape `hash.js` already uses to take `sha256bytes` off the core:
// "a hash that pins money should not gain a dependency whose version could
// change its output."
import { TICK_DT, TICKS_PER_SECOND_NUM, TICKS_PER_SECOND_DEN } from '../../core/src/tick.js';

export { TICK_DT };

/**
 * MILLISECONDS PER TICK, AS A REDUCED INTEGER RATIO.
 *
 *     TICK_DT / ONE seconds  =  1092 / 65536 s  =  1092000 / 65536 ms
 *                            =  34125 / 2048 ms   (exactly, after gcd)
 *
 * Derived, not typed: the numerator and denominator come out of the core's own
 * two numbers and a thousand, so there is no third literal here that could
 * drift away from the tick it was written for. Reduced once at load, because
 * the reduction is what keeps every product below the range where a caller
 * might be tempted to narrow it.
 */
const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
const MS_NUM_RAW = BigInt(TICKS_PER_SECOND_DEN) * 1000n;
const MS_DEN_RAW = BigInt(TICKS_PER_SECOND_NUM);
const G = gcd(MS_NUM_RAW, MS_DEN_RAW);

/** One tick is `MS_PER_TICK_NUM / MS_PER_TICK_DEN` milliseconds, exactly. */
export const MS_PER_TICK_NUM = MS_NUM_RAW / G;
export const MS_PER_TICK_DEN = MS_DEN_RAW / G;

const whole = (v, what) => {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  if (n < 0n) throw new RangeError(`${what} cannot be negative: ${n}`);
  return n;
};

/**
 * TICKS TO SECONDS, EXACTLY, IN THE CORE'S OWN Q16.16.
 *
 * The only conversion with no remainder anywhere: a tick IS `TICK_DT` of these
 * units, so a count of ticks is a multiplication and nothing is lost. Every
 * other unit below has to divide, and dividing is where a clock starts lying.
 */
export function secondsQ16ForTicks(ticks) {
  return whole(ticks, 'a tick count') * BigInt(TICK_DT);
}

/**
 * TICKS TO MILLISECONDS: the whole milliseconds, and the part that is left.
 *
 * `10800n` ticks is 179956 ms and 112/2048 of a millisecond - 179.9560546875
 * seconds - and not the three minutes anyone would assume. The remainder is
 * RETURNED rather than rounded away, because a millisecond dropped per call is
 * how a run and the invoice that covers it end up disagreeing about when the
 * round is over, and `exact` says outright whether anything was dropped.
 */
export function msForTicks(ticks) {
  const total = whole(ticks, 'a tick count') * MS_PER_TICK_NUM;
  const ms = total / MS_PER_TICK_DEN;
  const remainder = total - ms * MS_PER_TICK_DEN;
  return { ms, remainder, divisor: MS_PER_TICK_DEN, exact: remainder === 0n };
}

/**
 * MILLISECONDS TO TICKS: floor, and the leftover named as a fraction of a tick.
 *
 * FLOOR AND NOT ROUND. Three minutes is 10802.637 ticks: rounding gives 10803,
 * which is a tick of run nobody simulated, and a round whose last tick exists
 * only in the contract is a round whose transcript is short by one - a
 * disagreement between two honest nodes with nothing to arbitrate it. Floor
 * always lands inside the time available, and the 0.637 that is left comes
 * back as `remainder / divisor` so a caller can see it rather than discover it.
 *
 * The remainder is a fraction of ONE TICK, not a duration in some third unit:
 * inventing a unit here would be inventing a clock here.
 */
export function ticksForMs(ms) {
  const total = whole(ms, 'a duration in milliseconds') * MS_PER_TICK_DEN;
  const ticks = total / MS_PER_TICK_NUM;
  const remainder = total - ticks * MS_PER_TICK_NUM;
  return { ticks, remainder, divisor: MS_PER_TICK_NUM, exact: remainder === 0n };
}

/**
 * AND WHEN A CALLER NEEDS AN EXACT ANSWER, IT REFUSES RATHER THAN GUESSES.
 *
 * Some numbers must not be approximately right: a CLTV that expires half a
 * tick before the round ends is an escape hatch, and a run length that is a
 * tick out is a transcript that cannot be replayed to its own end. Those
 * callers ask here, and a duration that is not a whole number of ticks comes
 * back refused and named, with the remainder in the reason - not rounded to
 * the nearest tick with the difference unmentioned.
 */
export function exactTicksForMs(ms) {
  const got = ticksForMs(ms);
  if (!got.exact) {
    return {
      ok: false,
      why: `${ms} ms is ${got.ticks} ticks and ${got.remainder}/${got.divisor} of a tick, `
        + 'which is not a whole number of ticks',
    };
  }
  return { ok: true, ticks: got.ticks };
}
