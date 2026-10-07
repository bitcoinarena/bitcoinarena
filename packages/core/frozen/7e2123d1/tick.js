// THE TICK THE SIMULATION ACTUALLY RUNS, AND THE CORE IS WHAT KNOWS IT.
//
// Section 5 of multiplayer_p2p.md requires a "fixed protocol tick" and names
// no number: no rate, no interval, no unit, and nobody who emits one. Ticks
// are only ever the unit something else is counted in - a checkpoint's `tick`
// (10), an input batch's `first_tick`/`last_tick` (11), a late joiner's
// `join_tick`, "the exposure integral accumulated per simulation tick". The
// round contract, meanwhile, measures the round in TIME: `start_time`,
// `entry_close_time`, `player_run_duration // T_run`, with the worked example
// at "T_run: 3 minutes".
//
// So the conversion between the two is not in the spec, and it cannot be
// invented in the protocol either: the tick is a property of the simulation
// binary, which is what `sim_wasm_hash` / `simCoreHash` commits to. A round
// signed under one core and replayed under another must not be able to
// disagree about how long it was. The core states it; everything else reads
// it. That is the same rule as the payout table - one implementation, no
// second path - applied to time.
//
// IT IS NOT A SIXTIETH OF A SECOND. TICK_DT is 1092 in Q16.16, which is
// 0.01666259765625 s, and 1/60 is 0.016666... The two are not the same number
// and they do not round the same way: `rules/air.js` already had to write
// Y_LERP against the tick rather than against a sixtieth, because 1-exp(-2/60)
// gave 2149 where the tick asks for 2148. Sixty ticks is 65520 in Q16.16
// seconds, not 65536 - a second of ticks is 244 microseconds short of a
// second, and over a three-minute run that is worth about two and a half
// ticks. A protocol that wrote "60" would be a second clock disagreeing with
// the first.
//
// The only other place sixty is written down is a comment in `BlwpNet.cs`,
// which is exactly the leftover number not to copy into a money path.
import { ONE } from './fixed.js';

/**
 * ONE TICK, IN Q16.16 SECONDS. Every rule in `sim.js` steps by this and
 * nothing else, so it is the whole definition of how long a tick is.
 */
export const TICK_DT = 1092;

/**
 * TICKS PER SECOND, AS AN EXACT RATIO AND NEVER AS A NUMBER.
 *
 *     ONE / TICK_DT  =  65536 / 1092  =  60.014652...
 *
 * It does not divide, so any single value for it is already a rounding. Kept
 * as a numerator and a denominator: a caller that needs a count multiplies and
 * divides once, in integers, and whatever does not divide is a remainder it
 * can be told about rather than a difference it never sees. `TICKS_PER_SECOND`
 * as a float would put 60.014652 into arithmetic that has to agree bit for bit
 * on every machine, which is the one thing this core exists to prevent.
 *
 * Neither half is a fresh literal: the numerator IS `ONE`, the denominator IS
 * the tick, so there is no third number that could drift from the other two.
 */
export const TICKS_PER_SECOND_NUM = ONE;
export const TICKS_PER_SECOND_DEN = TICK_DT;
