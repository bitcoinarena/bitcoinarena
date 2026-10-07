// THE PROTOCOL TICK IS THE CORE'S TICK, AND IT IS NOT A SIXTIETH OF A SECOND.
//
// The spec requires a "fixed protocol tick" (section 5) and names no number,
// no unit and nobody who emits one, while the contract measures the round in
// milliseconds and the transcript counts ticks. The conversion is this file's
// subject, and the numbers below are the whole reason it cannot be guessed:
// sixty ticks is not a second, and three minutes is not a whole number of
// ticks. Every constant here is either imported from the core or derived from
// what the core exports - a second literal would be a second clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONE } from '../../nextblock/src/fixed.js';
import { TICK_DT as CORE_TICK_DT, TICKS_PER_SECOND_NUM, TICKS_PER_SECOND_DEN } from '../../nextblock/src/tick.js';
import {
  TICK_DT, MS_PER_TICK_NUM, MS_PER_TICK_DEN,
  secondsQ16ForTicks, msForTicks, ticksForMs, exactTicksForMs,
} from '../src/tick.js';

/**
 * ONE OWNER. The protocol re-exports what the core says; it does not have an
 * opinion about how long a tick is.
 */
test('the tick comes from the core and the ratio is exact, not a rate', () => {
  assert.equal(TICK_DT, CORE_TICK_DT);
  assert.equal(TICK_DT, 1092, 'the tick moved and this file did not');

  // the ratio is ONE : TICK_DT and neither half is a fresh number
  assert.equal(TICKS_PER_SECOND_NUM, ONE);
  assert.equal(TICKS_PER_SECOND_DEN, TICK_DT);

  // 1092/65536 s = 1092000/65536 ms = 34125/2048 ms, reduced
  assert.equal(MS_PER_TICK_NUM, 34125n);
  assert.equal(MS_PER_TICK_DEN, 2048n);
  assert.equal(MS_PER_TICK_NUM * BigInt(ONE), MS_PER_TICK_DEN * BigInt(TICK_DT) * 1000n,
    'the reduced ratio is not the tick it came from');

  // AND IT IS NOT SIXTY. 65536/1092 = 60.014652..., so a rate has no integer
  // value at all: sixty times the tick misses a second by 16 in Q16.16.
  assert.notEqual(BigInt(ONE) % BigInt(TICK_DT), 0n, 'the tick divides a second, so a rate exists');
  assert.equal(BigInt(TICK_DT) * 60n, 65520n);
  assert.equal(BigInt(ONE) - 65520n, 16n);
});

/**
 * SIXTY TICKS IS NOT ONE SECOND, and the difference is not a rounding error
 * anyone may absorb: it is 244 microseconds every second, in the direction
 * that makes a run LONGER in ticks than a naive count expects.
 */
test('sixty ticks is not a second', () => {
  assert.equal(secondsQ16ForTicks(60n), 65520n);
  assert.notEqual(secondsQ16ForTicks(60n), BigInt(ONE));

  const got = msForTicks(60n);
  assert.equal(got.exact, false, 'sixty ticks came out as a whole number of milliseconds');
  assert.equal(got.ms, 999n);
  assert.deepEqual([got.remainder, got.divisor], [1548n, 2048n]);   // 999.755859375 ms

  // a second, asked for in ticks, is not sixty of them
  const back = ticksForMs(1000n);
  assert.equal(back.ticks, 60n);
  assert.equal(back.exact, false, 'a second came out as a whole number of ticks');
  assert.deepEqual([back.remainder, back.divisor], [500n, 34125n]);
});

/**
 * TEN THOUSAND EIGHT HUNDRED TICKS IS 179.9560546875 SECONDS - the number
 * anybody who wrote "three minutes at sixty a second" would have meant, and it
 * is 44 milliseconds short of three minutes.
 */
test('10,800 ticks is 179.9560546875 seconds, not three minutes', () => {
  assert.equal(secondsQ16ForTicks(10800n), 11793600n);          // 179.9560546875 x 65536

  const got = msForTicks(10800n);
  assert.equal(got.ms, 179956n);
  assert.deepEqual([got.remainder, got.divisor], [112n, 2048n]); // .0546875
  assert.equal(got.exact, false);

  // stated as the exact rational, so the assertion is the number and not a
  // rendering of it: 179956 + 112/2048 ms = 179.9560546875 s
  assert.equal((got.ms * got.divisor + got.remainder) * 10000000n,
    1799560546875n * got.divisor, 'that is not 179.9560546875 seconds');

  // and it is short of three minutes, not equal to it
  assert.equal(180000n - got.ms, 44n);
});

/**
 * THREE MINUTES IS 10,802 TICKS AND A REMAINDER, and the remainder is handed
 * back rather than rounded away. Section 6's worked example says "T_run: 3
 * minutes"; the simulation cannot run 0.637 of a tick.
 */
test('three minutes is 10,802 ticks with a named remainder, and floors rather than rounds', () => {
  const got = ticksForMs(180000n);
  assert.equal(got.ticks, 10802n);
  assert.deepEqual([got.remainder, got.divisor], [21750n, 34125n]);
  assert.equal(got.exact, false);

  // FLOOR, NOT ROUND: 10802.637 rounds to 10803, which is a tick of run that
  // nobody simulated and that no transcript can contain.
  assert.notEqual(got.ticks, 10803n, 'three minutes was rounded up to a tick nobody ran');
  assert.equal(got.remainder * 2n > got.divisor, true,
    'the fixture cannot tell floor from round: the remainder is below a half');

  // the floor lands INSIDE the time available and the next tick does not
  assert.equal(msForTicks(got.ticks).ms <= 180000n, true);
  assert.equal(msForTicks(got.ticks + 1n).ms > 180000n, true);

  // AND A CALLER THAT NEEDS AN EXACT ANSWER IS REFUSED, not served a guess
  const exact = exactTicksForMs(180000n);
  assert.equal(exact.ok, false);
  assert.match(exact.why, /10802 ticks and 21750\/34125 of a tick/);
  assert.match(exact.why, /not a whole number of ticks/);
});

/**
 * The conversions are integers, both ways, and refuse what they cannot answer.
 */
test('the conversions are integer, reversible where they can be, and refuse the rest', () => {
  // a duration that IS a whole number of ticks comes back whole
  const whole = msForTicks(2048n);                    // 2048 x 34125/2048 = 34125 ms
  assert.equal(whole.exact, true);
  assert.equal(whole.ms, 34125n);
  const there = exactTicksForMs(34125n);
  assert.equal(there.ok, true);
  assert.equal(there.ticks, 2048n);

  // Numbers are accepted and become BigInt; nothing here is a float
  assert.equal(ticksForMs(1000).ticks, 60n);
  assert.equal(typeof msForTicks(1).ms, 'bigint');
  assert.equal(typeof secondsQ16ForTicks(1), 'bigint');

  // NEGATIVE TIME IS NOT A THING TO ROUND. Floor and truncation disagree below
  // zero, so a signed duration is refused rather than silently taking one.
  assert.throws(() => ticksForMs(-1n), /cannot be negative/);
  assert.throws(() => msForTicks(-1n), /cannot be negative/);
  assert.throws(() => secondsQ16ForTicks(-1n), /cannot be negative/);

  // A LONG ROUND STAYS EXACT IN BIGINT, and the round trip loses less than one
  // tick - it must, because flooring is the only thing that dropped anything.
  // An hour is 216052 ticks and 25500/34125 of one; those ticks are 3599987 ms
  // and 1124/2048, which is 13 ms short of the hour and under a tick's 16.66.
  const hour = ticksForMs(3600000n);
  assert.equal(hour.ticks, 216052n);
  assert.deepEqual([hour.remainder, hour.divisor], [25500n, 34125n]);
  const back = msForTicks(hour.ticks);
  assert.equal(back.ms, 3599987n);
  assert.deepEqual([back.remainder, back.divisor], [1124n, 2048n]);
  assert.equal(3600000n - back.ms, 13n);
  assert.equal(msForTicks(hour.ticks + 1n).ms >= 3600000n, true,
    'the round trip lost a whole tick or more, so the floor dropped more than the fraction');
});
