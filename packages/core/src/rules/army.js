// The two armies, ported from Army.cs.
//
// Units hold a line either side of the seam, walk toward it, and shoot at the
// courier when it is in range and worth shooting at. What matters for the score
// is the last part: the count of units actually in range is what "danger"
// means, and it replaced distance-to-a-line for good reason - the frontline is
// defined across the whole map, so a truck on the empty run-in to the gate
// could sit on it and be scored as though under fire.

import { ONE, add, sub, neg, mulFast, div, idiv, clamp, min, max, abs, length2 } from '../fixed.js';
import { sin, cos, atan2 } from '../trig.js';
import { below } from '../rng.js';

export const RIFLE_RANGE = Math.imul(26, ONE);
export const ARMOUR_RANGE = Math.imul(46, ONE);

/**
 * The courier's own reach and what a tank shell does to it.
 *
 * `Army.CourierRange` is 34 m, wider than the rifle's 26, and a hit takes
 * `Rand(5f, 11f)` - `Army.cs:638`, with Heat at zero as every recording has
 * it. Drawn in hundredths the way the shell's own damage is, so it is one
 * draw either way and the stream does not change shape with the target.
 */
export const COURIER_RANGE = Math.imul(34, ONE);
export const COURIER_DAMAGE_MIN = Math.imul(5, ONE);
export const COURIER_DAMAGE_SPAN = Math.imul(6, ONE);   // 5 to 11

/**
 * What a RIFLE round does to the truck: `Rand(1.5f, 3.5f)`, `Army.cs:737`.
 *
 * A different band from the tank's on purpose - the recorder tells the two
 * weapons apart by the size of the hit, and with Heat at zero 1.5-3.5 and
 * 5-11 do not meet. A rifleman does one point to another rifleman and this to
 * the truck; the two are not the same number and never were.
 */
export const COURIER_RIFLE_MIN = Math.imul(3, ONE) >> 1;   // 1.5
export const COURIER_RIFLE_SPAN = Math.imul(2, ONE);       // to 3.5
export const RIFLE_HIT_PER_MIL = 45;        // 0.045 per shot
// Closing speeds, measured off the C# army rather than chosen: it covers
// -77.5 to -43.5 in five seconds with armour and -77.5 to -64.6 with
// infantry. See test/vectors/csharp-army.json.
const ARMOUR_WALK = 445645;      // 6.8 m/s
const RIFLE_WALK = 182714;       // 2.788 m/s

// A rifleman's own pace, as a factor on that.
//
//     unit.pace = Rand(0.82f, 1.18f)        Army.cs:278, infantry only
//     gait      = pace * (0.82 + 0.18 * sin(phase * 0.7))
//     step      = min(3.4f * gait * dt, |dz|)
//
// DIMENSIONLESS, and a factor rather than a speed: 3.4 is the m/s in the C#
// and 2.6 is the m/s here, and multiplying the existing constant by a mean-one
// factor leaves the mean where it was measured and adds only the spread.
//
// The spread is the whole of item (q). Every man walked at exactly 2.6 m/s, so
// a squad that set off together arrived together: infantry z-spread at t=15
// was 1.09 against the recording's 4.3-4.4, which is the spawn jitter and
// nothing else. Worked out from the C# ranges, `pace` alone accounts for about
// 3.75 m of that 4.3 - the halt another 1.5 and the gait wave, over ten cycles
// in fifteen seconds, none of it.
const RIFLE_PACE_MIN = 53740;    // 0.82
const RIFLE_PACE_SPAN = 23593;   // 0.36, so 0.82 to 1.18

/**
 * A man's pace, from his index rather than from the stream.
 *
 * `standoff` and `squadOffsetZ` are already derived this way - see `scatter`
 * and `scatter2` in `holdLine` - because a spawn draw is protocol: inserting
 * one shifts every draw after it, for every unit of every round, and the C#
 * order this core was matched against has no room left in it. A hash costs
 * nothing and shifts nothing.
 *
 * It needs a SECOND ROUND of mixing rather than a third window of the first.
 * Bits 20..29 and 8..17 are already spoken for by the two offsets, and a
 * window overlapping either would tie a man's speed to where he stands - a
 * correlation the C# does not have, because its two draws are independent.
 * Same magic number, applied twice, rather than a second one to justify.
 */
function paceOf(index) {
  let h = Math.imul(index | 0, 2654435761);
  h ^= h >>> 16;
  return add(RIFLE_PACE_MIN, Math.imul((Math.imul(h, 2654435761) >>> 20) & 1023,
                                       RIFLE_PACE_SPAN) >> 10);
}

// Where each kind stops. Armour pushes to the line and holds a little short
// of it; infantry closes further before it settles. Both sides doing this is
// what makes a front rather than a breakthrough - the means oscillate about
// the seam and never cross it.
// What the C# army AIMS for. It settles much further back than this, and it
// earns that distance rather than declaring it: StepArmour walks towards
// front - Dir*9, and backs off whenever an enemy is inside 24 m. The mean of
// 25 in the recording is the outcome of that give and take.
//
// It was declared at 25 for a while, as a stand-in for the behaviour, and the
// difference matters: a declared distance holds every unit on one line, so
// the fight is all or nothing - at 18 m apart both sides are ground to a
// third in a minute, at 50 nobody is ever in range at all. Backing off
// individually is what produces the scatter, and the scatter is what makes it
// a grind.
const ARMOUR_STANDOFF = Math.imul(9, ONE);
const ARMOUR_SPREAD = Math.imul(10, ONE);

// A rifleman's distance from the seam, and it is TWO numbers in the C#, added:
//
//     standoff     = Rand(4f, 12f)          Army.Spawn
//     squadOffsetZ = Rand(-5f, 5f)          Army.Spawn, infantry only
//     goalZ        = front - Dir * (standoff + squadOffsetZ)   StepInfantry
//
// So a man holds anywhere from 1 m PAST the seam to 17 m short of it, and the
// sum of two uniforms is triangular - it piles up at 8. The core had a flat
// 0 to 8, mean 4, so both lines stood four metres too far forward and half as
// deep, which puts them eight metres closer together than the recording's.
//
// That is not a cosmetic difference. It is how densely the men pack where the
// bombs fall: with the lines too close and too shallow the core killed 81-116
// riflemen a round by bomb against the recording's 60-76, and only 42-49% of
// its bombs hit nobody against 50-58%. Measured, both before and after.
// ---- the halt -----------------------------------------------------------
//
// `Army.cs:658-666`: a man stops for 0.4 to 1.8 s every 3 to 11 s, about
// 13.6% of his time, and the clock that counts down to the next halt only
// runs while he is walking - so the cycle is an interval and then a stop, and
// BOTH are redrawn at the start of every stop. His first interval is seeded
// shorter, `nextRest = Rand(2f, 9f)` at spawn.
//
// IN TICKS, because that is what this core counts. Seconds are the C#'s unit
// and would be a number that means nothing here.
const HALT_MIN = 24, HALT_SPAN = 84;        // 0.4 s .. 1.8 s
const REST_MIN = 180, REST_SPAN = 480;      // 3 s .. 11 s
const FIRST_MIN = 120, FIRST_SPAN = 420;    // 2 s .. 9 s, the spawn seed

/**
 * The k-th interval and the k-th stop of one man, from a hash.
 *
 * NOT from the stream. C# draws these in the middle of the step, interleaved
 * with the firing draws, so taking them from the core's stream would move
 * every draw after them in every round - and 77 of the 78 quantities this army
 * is measured on currently sit inside the recording's envelope. A hash moves
 * nothing.
 *
 * The draw is per (index, CYCLE), and that is the whole design. Drawing once
 * per man - a fixed period and duty cycle, `tick % P < R` - was tried first
 * and fails: it locks every man to his own ratio for ever, so the spread over
 * a run never settles. Measured over 900 and 5400 ticks against the C# process
 * itself: C# 12.09% then 13.60% with a spread of 4.79 falling to 1.84, the
 * fixed-period version 14.67% both times with a spread stuck at 7.20 and 6.64.
 * Redrawing per cycle reproduces the fall, because it reproduces the reason
 * for it - a man who rerolls averages out and a man who does not, does not.
 */
function haltDraw(index, cycle, salt) {
  let h = Math.imul(add(add(index | 0, Math.imul(cycle | 0, 0x9e3779b1)), salt), 2654435761);
  h ^= h >>> 16;
  return (Math.imul(h, 2654435761) >>> 20) & 1023;
}

/**
 * Is this man standing still on this tick?
 *
 * The cycle a tick falls in is found by summing from zero, because nothing is
 * stored: about eleven steps at ninety seconds and nineteen at a full block.
 * The alternative was a ninth word per unit, which moves `O_ARMY`, `O_AIR`,
 * `O_HELIS`, `O_BOMBS`, `O_SQUADS`, `WORDS`, `BlwpLayout.cs` and the C# state
 * buffer - a protocol change for one comparison of seventy-eight.
 */
export function standingStill(index, tick) {
  let at = 0;
  for (let k = 0; k < 512; k++) {
    const first = k === 0;
    const rest = add(first ? FIRST_MIN : REST_MIN,
                     Math.imul(haltDraw(index, k, 0), first ? FIRST_SPAN : REST_SPAN) >> 10);
    const stop = add(HALT_MIN, Math.imul(haltDraw(index, k, 1), HALT_SPAN) >> 10);
    if (tick < add(at, rest)) return false;
    if (tick < add(add(at, rest), stop)) return true;
    at = add(add(at, rest), stop);
  }
  return false;
}

// A tank turns before it drives, and it never drives sideways.
//
//   `mvx*mvx + mvz*mvz > dt*dt*0.16f` is C#'s guard at 0.4 m/s, which for one
//   tick at a sixtieth is 0.4/60 m = 437 in Q16.16 - a distance against a
//   distance, not a speed against a step.
//   `1 - exp(-2.2f * dt)` at a sixtieth is 0.03608 = 2365 of 65536.
//   `|dz| > 0.6f` is the infantry's own walking test, 39322 in Q16.16.
const TURN_FLOOR = 437;
const TURN_RATE = 2365;
const WALK_FACING_FLOOR = 39322;

const RIFLE_STANDOFF = Math.imul(4, ONE);
const RIFLE_SPREAD = Math.imul(8, ONE);      // + 0 to 8, so 4 to 12
const RIFLE_SQUAD_Z = Math.imul(10, ONE);    // then -5 to +5

/**
 * Pushed this far past its own line, a unit is overrun and falls right back.
 *
 * This is the missing half of the front's shape. Advance-and-back-off alone
 * settles every unit onto one line - the measured z spread collapsed from 23
 * to 9 while the C# army holds 20 - and a single line means both armies meet
 * at once and half the armour dies in the ten seconds after contact. Units
 * thrown right back and coming forward again are what keeps the strip
 * populated at different depths, so contact is a rolling local thing instead
 * of one collision.
 */
const OVERRUN_DEPTH = Math.imul(14, ONE);   // Army.OverrunDepth
const FALL_BACK = Math.imul(34, ONE);

/** Inside this, a tank gives ground rather than closing further. */
/** The battlefield's half width, as Army.FrontX has it. */
const FRONT_X = Math.imul(92, ONE);

/** Squad anchors along the front, and how wide a squad stands. */
const SQUADS = 8;
/**
 * Picking a squad is a mask, not a remainder: '%' is division, and division
 * lives in fixed.js. Which means SQUADS has to stay a power of two - so the
 * mask is written from it rather than as a bare 7, and a change to five or
 * twelve breaks loudly here instead of quietly assigning every unit to squad
 * zero.
 */
const SQUAD_MASK = SQUADS - 1;
const SQUAD_SPAN = Math.imul(76, ONE);     // anchors run from -76 to +76
const SQUAD_WIDTH = Math.imul(16, ONE);    // each unit sits within 8 m of its anchor
const SQUAD_OFFSET = Math.imul(18, ONE);   // a rifleman: Army.Spawn's Rand(-9, 9)
const TWO = Math.imul(2, ONE);

const BACK_OFF_RANGE = Math.imul(24, ONE);
/**
 * How much ground a crowded tank gives, and it is a DISTANCE.
 *
 * `StepArmour` says `goalZ = v.z - v.Dir * 6f` and then `speed *= 0.35f`. The
 * six is a GOAL - a point six metres back - and the rate is the walk cut to a
 * third. This line used to read `6 * ONE` and was spent as
 * `dz = BACK_OFF * side * dt`, which is the six read as a SPEED: six metres a
 * second, for as long as the crowding lasts, and squarely in z. Wrong unit and
 * wrong component in one line.
 *
 * The fix is NOT to copy the number C# is left holding. Its backward rate is
 * `0.35 * speed * 6/gl`, a leftover of steering at `foe.x` and at the seam in
 * one vector - and that coupling was ported here once, measured, and reverted;
 * the note on the lateral drift further down has the numbers. Reproducing a
 * magnitude without its cause is the same mistake facing the other way.
 *
 * So this is stated in the core's own terms, which it can be because there is
 * already a hold and a controller that walks to one: a crowded tank's hold
 * moves six metres further back, it walks there at a third of its speed, and
 * it STOPS. Bounded, in metres, no coupling - and unlike a velocity it cannot
 * accumulate over a round.
 */
const BACK_OFF = Math.imul(6, ONE);             // metres of ground given
const CROWD_WALK = mulFast(ARMOUR_WALK, 22938); // 0.35 * 6.8 m/s, StepArmour's cut
const OVERRUN = Math.imul(14, ONE);

/**
 * Tanks do not stand inside each other.
 *
 * `Army.Update` opens with `Separate(Armour[i], Armour[j])` over every pair,
 * before it steps anything, and the comment on it says the overlap was "the
 * single most reported fault in the three.js build". This core had no such
 * rule at all - `Separate` appeared in it only in comments explaining that the
 * INFANTRY has none - and nothing recorded it, because in C# it is true by
 * construction and a recording of a constant is not worth taking.
 *
 * It was tolerable while the armour held a ladder of fixed posts: 2.16% of
 * pairs closer than C# allows, and the closest pair at a typical sample 3.61 m.
 * Then an engaged tank was given its enemy's x to close on, which is what C#
 * does - and two tanks closing on the SAME enemy converge on bitwise the same
 * x. Measured after that change: 7.25% of pairs too close and the closest pair
 * at a typical sample 0.03 m, which is two hulls occupying one point. The chase
 * is not wrong; half a rule was ported. C# runs the chase and this together.
 *
 * The coincident case is skipped exactly as C# skips it - `d2 <= 1e-4f`, a
 * hundredth of a metre - because a zero separation has no direction to push
 * along. That only stays harmless while this runs from the first tick, which
 * is why it is at the top of the army's step and not somewhere convenient.
 */
const FRIENDLY_SPACING = Math.imul(17, ONE) >> 1;   // 8.5 m, Army.FriendlySpacing
const HOSTILE_SPACING = Math.imul(15, ONE) >> 1;    // 7.5 m, Army.HostileSpacing
const COINCIDENT = 655;                             // 0.01 m, C#'s 1e-4 on d2

export function separatePair(s, a, b, xOff, zOff, sideOff) {
  const min = s[a + sideOff] === s[b + sideOff] ? FRIENDLY_SPACING : HOSTILE_SPACING;
  const dx = sub(s[b + xOff], s[a + xOff]), dz = sub(s[b + zOff], s[a + zOff]);
  // Cheap axis reject first, which also keeps length2 well inside its range.
  if (abs(dx) >= min || abs(dz) >= min) return;
  const d = length2(dx, dz);
  if (d <= COINCIDENT || d >= min) return;

  const push = sub(min, d) >> 1;
  const nx = div(dx, d), nz = div(dz, d);
  const px = mulFast(nx, push), pz = mulFast(nz, push);
  s[a + xOff] = sub(s[a + xOff], px);
  s[a + zOff] = sub(s[a + zOff], pz);
  s[b + xOff] = add(s[b + xOff], px);
  s[b + zOff] = add(s[b + zOff], pz);
}

/**
 * Nobody is left standing inside the cab.
 *
 * `Army.ClearPath` reads like a corridor rule - it takes a `halfWidth` of 7.5
 * and an `ahead` of 26, and its anticipatory branch eases a man sideways out
 * of the truck's path. THAT BRANCH NEVER RUNS. Its only call is
 * `foreach (var u in Infantry) YieldTo(u, 0f, 0.9f, false, 1.6f)`, with
 * `stepsAside` false and `rate` zero, and no other caller exists; the corridor,
 * the urgency ramp and both parameters are dead code in the game they are in.
 * What the game actually does is the last-resort half: a rifleman inside 1.6 m
 * of the truck's centre is pushed back out to it.
 *
 * So that is what is ported. Porting the corridor would be porting something
 * the old game never executed, and the envelope it would move is not evidence
 * of anything. This also corrects a claim of mine in the step 2 measurement:
 * the reason at most one man was ever inside 3.6 m was NOT this rule easing
 * thirteen of them aside, because it eases nobody aside.
 *
 * ARMOUR IS DELIBERATELY ABSENT, as it is in C#, and for the reason its
 * comment gives: two systems arguing over one overlap have no radius that
 * satisfies both. Here `resolveArmour` already pushes the TRUCK out of the
 * tanks, and this pushes the MAN out of the truck - one owner each.
 *
 * The radius is derived rather than typed: 1.6 m is 16 ONE over 10.
 */
const CLEAR_RADIUS = idiv(Math.imul(16, ONE), 10);   // 1.6 m, C#'s `hard`

/**
 * Anyone under the wheels goes down.
 *
 * `Army.RunOver(x, z, 3.6f, speed, knock)` with `minSpeed = 2.5f`: below a
 * walking pace nothing happens, because a truck edging forward should not mow
 * down a line it is merely touching and a stationary one should not clear a
 * space around itself.
 *
 * THE SPEED IS THE CORE'S OWN VELOCITY, and getting that right is the whole
 * of this port. `Battlefield` reads `BlwpCore.Velocity` - which is (T_VX,
 * T_VZ) - and takes its magnitude, falling back to `Rigidbody.linearVelocity`
 * only when the core is not driving. That fallback is the PhysX remnant and
 * the comment above it in the game says what it cost: the truck's body is
 * kinematic, its linearVelocity is permanently zero, so run-over read a
 * stationary truck and infantry stood in the road while the wheels went
 * through them. The core has no such fallback and must not grow one.
 *
 * It is also NOT `T_WHEEL`. That is the vehicle's signed forward speed - the
 * suspension model takes `abs()` of it wherever it needs a magnitude - so a
 * truck reversing at 5 m/s would read as -5, sit below the 2.5 threshold and
 * ride over nobody. C# takes a magnitude and so does this: the same quantity,
 * not the nearest one to hand.
 *
 * `knock` is not ported. It exists to throw the body the way it was hit, and
 * nothing in the core draws anything; it belongs with the rest of CombatFx.
 */
const RUN_OVER_RANGE = idiv(Math.imul(36, ONE), 10);   // 3.6 m, Battlefield.cs:144
const RUN_OVER_MIN_SPEED = Math.imul(5, ONE) >> 1;     // 2.5 m/s, Army.RunOver's default

/** The truck's speed as C# reads it: the magnitude of the core's own velocity. */
export const truckSpeed = (vx, vz) => length2(vx, vz);

export function runOver(s, b, tx, tz, speed, xOff, zOff) {
  if (speed < RUN_OVER_MIN_SPEED) return 0;
  const dx = sub(s[b + xOff], tx), dz = sub(s[b + zOff], tz);
  if (abs(dx) >= RUN_OVER_RANGE || abs(dz) >= RUN_OVER_RANGE) return 0;
  if (length2(dx, dz) >= RUN_OVER_RANGE) return 0;
  return 1;
}

export function clearOfTruck(s, b, tx, tz, xOff, zOff) {
  const ox = sub(s[b + xOff], tx), oz = sub(s[b + zOff], tz);
  if (abs(ox) >= CLEAR_RADIUS || abs(oz) >= CLEAR_RADIUS) return 0;
  const d = length2(ox, oz);
  // Coincident is skipped exactly as C# skips it (`d2 > 1e-4f`): a zero
  // separation has no direction to push along.
  if (d <= COINCIDENT || d >= CLEAR_RADIUS) return 0;

  const push = sub(CLEAR_RADIUS, d);
  s[b + xOff] = add(s[b + xOff], mulFast(div(ox, d), push));
  s[b + zOff] = add(s[b + zOff], mulFast(div(oz, d), push));
  return 1;
}

export const SIDE_BULL = -1;
export const SIDE_BEAR = 1;

/**
 * Advances one unit. `u` is a view object over the state's words.
 *
 * Draw order, and it is protocol: wobble, then - only if in range and the
 * cooldown has expired - reload, then the hit roll. Nothing may be inserted
 * before the wobble or every recorded transcript stops replaying.
 */
export function stepUnit(u, rng, seamZ, truckX, truckZ, halfX, halfZ, dt, index, tick) {
  if (u.hp <= 0) return 0;

  // THE DRAW STAYS, THE WOBBLE GOES.
  //
  // `heading += Rand(-32, 32)` was a random walk that knew nothing about where
  // the unit was going, and the renderer draws the hull from it. Measured over
  // sixteen seeds, the angle between a tank's travel and its drawn hull
  // averaged 90.5 degrees, was past 45 three quarters of the time and past 90
  // half of it: half the tanks on screen were sliding sideways or driving
  // backwards. C# has no wobble anywhere.
  //
  // The DRAW is kept and its value thrown away. It is the first draw of the
  // unit's tick and the comment above calls that order protocol - every
  // transcript and every recorded pass replays this stream, and dropping a
  // draw here would shift every draw after it for every unit of every round.
  // Keeping it costs nothing; using it for a heading was the fault.
  below(rng, 64);

  // Advance on the seam from our own side and hold short of it.
  //
  // The stand-off is what keeps this a front. Walking onto the seam and
  // stopping there puts both armies on one line and the first side with a
  // rounding advantage walks through; holding short leaves a contested strip
  // between them, which is what the C# army does and why its means oscillate
  // about zero for ninety seconds without ever crossing.
  // A man who is standing still walks nowhere, in either axis. C# reaches the
  // same place through `gait = halted ? 0f : ...` and by skipping the lateral
  // station-keeping in the same tick.
  //
  // C#'s halt only STARTS when he is more than 2 m from his goal, and a due
  // halt is postponed until that holds. This does not carry that across: it is
  // a coupling between where he stands and when he stops, and the condition
  // only bites once he is ON his post - which is not the approach the mark at
  // t=15 measures. Named here rather than ported blind.
  const still = !u.armour && standingStill(index, tick | 0);
  const walk = u.armour ? ARMOUR_WALK
             : still ? 0 : mulFast(RIFLE_WALK, paceOf(index));
  // Each unit holds at its OWN distance, scattered about the mean.
  //
  // A single stand-off for everyone puts the whole army on one line, and then
  // it is all or nothing: at nine metres apart every tank is permanently
  // inside the 46 m gun range and both sides are ground to a third in a
  // minute; at fifty, nobody is ever in range and nobody dies at all. The C#
  // army sits at a mean of 25 with a spread near 20, and that spread is what
  // produces the trickle of engagements that makes it a grind.
  //
  // Derived from the index rather than stored: it must not change from tick to
  // tick, and there is no spare word in the unit for it.
  const scatter = (Math.imul(index | 0, 2654435761) >>> 20) & 1023;
  // A second slice of the same hash, so the rifleman's two offsets are
  // independent of each other the way the C#'s two draws are. Same hash and a
  // different window rather than a second constant: one magic number is enough
  // to have to justify.
  const scatter2 = (Math.imul(index | 0, 2654435761) >>> 8) & 1023;
  const standoff = u.armour
    ? add(ARMOUR_STANDOFF,
          sub(Math.imul(scatter, ARMOUR_SPREAD) >> 10, ARMOUR_SPREAD >> 1))
    : add(add(RIFLE_STANDOFF, Math.imul(scatter, RIFLE_SPREAD) >> 10),
          sub(Math.imul(scatter2, RIFLE_SQUAD_Z) >> 10, RIFLE_SQUAD_Z >> 1));
  // The side a unit BELONGS to, not the side it happens to be standing on.
  //
  // Taken from the current position, a unit that stepped over the seam had its
  // stand-off flip and was sent back - so armour oscillated across the line
  // instead of holding short of it, and by t=10 the whole force had walked
  // through a front that no longer existed.
  const side = u.side < 0 ? -1 : 1;
  const hold = add(seamZ, Math.imul(side, standoff));

  // Give ground when something is too close.
  //
  // This is the whole of the front's shape. A unit that only advances stands
  // on one line with every other unit; one that backs off when crowded ends up
  // scattered through a contested strip, which is where the trickle of
  // engagements comes from.
  // Overrun: past our own line by more than a few metres, fall right back.
  // NOT side: the Bull army spawns at negative z, so its side is -1 while its
  // Dir - the way it faces and pushes - is +1. Using side made every unit read
  // as overrun the moment it reached its own holding line, so the whole army
  // sat on the fall-back line and never fired a shot.
  const past = mulFast(sub(u.z, seamZ), Math.imul(-side, ONE));
  // ARMOUR ONLY, and that is C#'s own division, not a preference.
  //
  // `StepArmour` falls back to `front - Dir*34` when a tank has overrun its
  // own line (`Army.cs:566-567`). `StepInfantry` has NOTHING of the sort: it
  // walks to `front - Dir*(standoff + squadOffsetZ)` and that is the whole of
  // it (`:651-653`). No overrun, no giving ground.
  //
  // Applied to riflemen it parked the infantry: a man who pushed 14 m past
  // the line was thrown 34 m behind it and had to walk in again, so the line
  // never formed. Measured against the front at each man's own x, the
  // infantry sat 36.5 m behind it at t=30 - and FALL_BACK is 34.
  const overrun = u.armour && past > OVERRUN_DEPTH;

  let dz;
  if (overrun) {
    const back = add(seamZ, Math.imul(side, FALL_BACK));
    const g = sub(back, u.z);
    dz = mulFast(mulFast(walk, g > 0 ? ONE : -ONE), dt);
  } else if (u.crowded) {
    // Armour only, and `crowded` is now only ever set for armour - the scan
    // in sim.js does not run for a rifleman at all.
    //
    // This is StepArmour's `if (engaged && foeD2 < 24*24)`: a tank that has
    // another tank inside 24 m gives six metres of ground. C# INFANTRY has no
    // such rule anywhere - Separate is called on Armour pairs only
    // (Army.cs:325) and StepInfantry walks a man to his standoff and leaves
    // him there. Applying it to riflemen held the two lines 24.0 m apart at
    // every sample of every seed, which is wider than the 16 m blast, so no
    // bomb in this core could ever catch men from both sides; the recording's
    // lines come within 4.7 m of each other. That floor was the whole of the
    // friendly-fire and dud-share gap the air arm was blamed for.
    // Six metres further back than it would otherwise hold, walked to and then
    // held - not a retreat that runs for as long as the crowding does.
    const back = add(hold, Math.imul(side, BACK_OFF));
    const g = sub(back, u.z);
    const want = abs(g) > mulFast(CROWD_WALK, dt) ? (g > 0 ? ONE : -ONE) : 0;
    dz = mulFast(mulFast(CROWD_WALK, want), dt);
  } else {
    const gap = sub(hold, u.z);
    const want = abs(gap) > mulFast(walk, dt) ? (gap > 0 ? ONE : -ONE) : 0;
    dz = mulFast(mulFast(walk, want), dt);
  }
  // Sideways: hold a squad position, not a random walk.
  //
  // A unit that wanders freely fills whatever room it is given. Clamped to the
  // battlefield the core's armour still spread from 57 m to 87 m of standard
  // deviation over a minute - past uniform, so they were piling at the edges -
  // while the C# army holds 36 to 45 throughout. It holds it because units do
  // not wander at all: EnsureSquads anchors them along the front and each unit
  // keeps its own offset from its anchor.
  //
  // Without that the two armies drift apart sideways and stop meeting: by t=60
  // seven tanks were alive and NOT ONE was shooting. The fight was over, and
  // that is what looked like heavy attrition - all of it happened in the first
  // thirty seconds and then nothing.
  // Bit three and up, so that a squad holds one unit from EACH side.
  //
  // index % SQUADS collides with the side assignment: armour is every fourth
  // index and the side is bit two, so armour fell into just two squads, one
  // per army, and the two lines stood at opposite ends of the field. Twenty
  // three of twenty four tanks survived a minute because not one of them ever
  // saw an enemy.
  // ARMOUR keeps the ladder. INFANTRY is given C#'s own geometry instead: three
  // drawn anchors a side that walk, handed in as u.anchor, and a man sits at
  // anchor + Rand(-9, 9) on it.
  //
  // The ladder is an invention of this core and it stays for the tanks, because
  // C# armour has no squad at all - StepArmour steers at its foe's x - and
  // without the ladder the two armies drifted apart sideways and stopped
  // meeting. For the riflemen it was doing active harm: eight evenly spaced
  // columns SHARED BY BOTH SIDES meant a bomb that caught anybody caught men
  // of both armies, so half of what the air killed was its own (34-49 a round
  // against the recording's 11-29), and eight knots spread over the front left
  // too little empty ground for a bomb to fall on (dud share 0.38-0.46 against
  // 0.50-0.58).
  const squad = ((index | 0) >> 3) & SQUAD_MASK;
  const anchor = u.armour
    ? sub(Math.imul(squad, div(Math.imul(2, SQUAD_SPAN), Math.imul(SQUADS - 1, ONE))),
          SQUAD_SPAN)
    : u.anchor;
  const ladder = add(anchor, sub(Math.imul((Math.imul(index | 0, 2654435761) >>> 22) & 255,
                                           div(SQUAD_WIDTH, Math.imul(255, ONE))),
                                 div(SQUAD_WIDTH, TWO)));
  // An engaged tank closes on its enemy's x. IN X ONLY, and that is the whole
  // difference from the version this core ported once and reverted.
  //
  // What was reverted steered at `(foe.x, seam - Dir*9)` as ONE normalised
  // vector, the way StepArmour does. Normalising is what did the damage: the
  // z component is then dragged along by the size of the x chase, the front
  // lost its depth (z spread 9-12 down to 1.9-11.7) and one side was wiped out
  // on two seeds. Here x and z stay on their own controllers - z is still the
  // hold, clamped at its own walk, and knows nothing about the foe - so the
  // depth cannot be spent on the chase. Both are measured below and in
  // PRIORITIES, because a change that fixes presence by flattening the front
  // has not fixed anything.
  //
  // The ladder stays for a tank with nobody to close on. It was invented here
  // because armour left to a heading wobble random-walks to the map edges and
  // stops meeting anything at all; it is a place to wait, not a place to fight
  // from. Eight fixed posts from -76 to +76 put only two of them inside the
  // truck's 34 m, which is why 35% of the armour was ever near it against the
  // recording's 71% - the spread was right (sd 46 against C#'s 36-45) and the
  // SHAPE was flat where the recording's is peaked.
  const post = u.armour ? (u.engaged ? u.foeX : ladder) : riflePost(anchor, index);
  const dxWant = sub(post, u.x);
  const dxCap = mulFast(walk, dt);
  const dx = clamp(dxWant, neg(dxCap), dxCap);

  // Sideways: a slow drift. NOT a chase towards the engaged foe.
  //
  // StepArmour steers towards (foe.x, front - Dir*9) as one vector, and
  // porting that coupling was the obvious way to get the depth the front is
  // missing. Measured, it made things worse: the z spread fell from 9-12 to
  // 1.9-11.7 and one side was wiped out on two seeds, because chasing pulls
  // both armies onto the same x and concentrates the fighting rather than
  // spreading it. Reverted rather than kept, since the whole point of the
  // change was to raise that number.
  // Held on the BATTLEFIELD, not merely on the map.
  //
  // The heading wobbles, so the lateral step is a random walk, and clamped at
  // the map edge it is a random walk with 130 m of room: after thirty seconds
  // the surviving tanks were spread from -130 to +130 with not one enemy
  // inside gun range of another. The fight was a massacre in the first twenty
  // seconds and then nothing at all, which is why attrition looked like twice
  // the C# army's - it was not a faster grind, it was no grind.
  //
  // Unity holds every unit inside |x| < FrontX - 4 for exactly this reason.
  // A TANK DRIVES WHERE IT IS POINTING, AND NOWHERE ELSE.
  //
  // C# turns the hull INTO its line of advance - `Army.cs:587-590`, a lerp at
  // 2.2 per second - and that is enough there, because StepArmour moves along
  // ONE goal vector so the direction of travel is smooth. This core steers x
  // and z on separate controllers, deliberately: coupling them into one
  // normalised vector was tried, measured and reverted, because the z
  // component then gets dragged along by the size of the x chase and the front
  // loses its depth. The price of keeping them apart is that the direction of
  // travel jitters, so a hull that merely CHASES it still ends up 45.7 degrees
  // off on average - measured, better than 90.5 and not the rule.
  //
  // So the constraint goes on the velocity, not on the drawing: the two
  // controllers say how FAR to go, the heading says which way, and the step is
  // taken along the heading. The tank turns towards where it wants to be at
  // C#'s own rate and drives forward - it cannot strafe, because there is no
  // longer a sideways component to strafe with.
  let stepX = dx, stepZ = dz;
  if (u.armour) {
    const far = length2(dx, dz);
    if (far > TURN_FLOOR) {
      const want = atan2(dx, dz);
      // the short way round, or a tank crossing north turns the long way home
      const off = (((want - u.heading + 32768) & 65535) - 32768) | 0;
      u.heading = add(u.heading, Math.imul(off, TURN_RATE) >> 16) & 65535;
      stepX = mulFast(sin(u.heading), far);
      stepZ = mulFast(cos(u.heading), far);
    }
  }

  const edge = sub(FRONT_X, Math.imul(4, ONE));
  u.x = clamp(add(u.x, stepX), neg(min(edge, halfX)), min(edge, halfX));
  u.z = clamp(add(u.z, stepZ), -halfZ, halfZ);

  // The rifleman is not a vehicle and C# does not treat him as one: he walks
  // in z and holds his squad's x, and he simply FACES the way he is walking,
  // or the enemy when he is dug in. `Army.cs:692-694`. No lerp, no constraint.
  if (!u.armour) {
    u.heading = (abs(stepZ) > WALK_FACING_FLOOR
                   ? (stepZ > 0 ? 0 : 32768)
                   : (u.side < 0 ? 0 : 32768)) | 0;
  }

  // The courier is NOT a weapon, and this function no longer has one.
  //
  // What stood here was a second gun bolted onto the tank: its own 40-99 tick
  // clock, the rifle's 0.045 roll, a 26 m reach and one flat point of damage.
  // The C# has nothing of the sort. `Army.StepArmour` fires the tank's ONE gun
  // when it is engaged, and the courier is only a TARGET CHOICE inside that
  // shot - taken when the truck is inside CourierRange and nearer than the
  // enemy the tank had picked. So the parallel weapon is deleted rather than
  // widened to 34 m, and the choice now lives in sim.js beside the gun, which
  // is the only place that can see both the foe and the truck.
  //
  // Measured before it went: 263 shots a round for 11 points, against the
  // recording's 163 hits for 1271.7.
  return 0;
}

/**
 * The nearest enemy RIFLEMAN inside rifle range, or -1.
 *
 * `Army.NearestEnemyInfantry`, and the counterpart of pickTarget: that one
 * scans armour for a tank's gun, this one scans infantry for a rifle. A
 * rifleman never shoots at a tank in the C# and does not here.
 *
 * Called when the shot goes off and not every tick, which is C#'s own choice
 * and its own comment: a hundred and eighty men each scanning every other man
 * every frame is thirty thousand comparisons for a decision that changes once
 * every few seconds.
 */
/**
 * Where a rifleman stands on his squad's anchor.
 *
 * `Army.Spawn` draws `squadOffsetX = Rand(-9f, 9f)` once and `StepInfantry`
 * walks him to `squads[squad] + squadOffsetX` for the rest of his life. Here
 * it comes off the slot index instead of a word, because there is no spare
 * word in the unit - which does mean a replacement inherits the offset of the
 * man whose slot it took, where C# draws a fresh one. Same distribution, one
 * fewer degree of freedom.
 *
 * Shared, so that the post a man spawns on and the post he walks to cannot
 * drift apart.
 */
export function riflePost(anchor, index) {
  const offset = sub(Math.imul((Math.imul(index | 0, 2654435761) >>> 22) & 255,
                               div(SQUAD_OFFSET, Math.imul(255, ONE))),
                     div(SQUAD_OFFSET, TWO));
  return add(anchor, offset);
}

export function pickRifleTarget(units, count, self, x, z, side) {
  let best = -1, bestD = RIFLE_RANGE;
  for (let i = 0; i < count; i++) {
    if (i === self) continue;
    const u = units(i);
    if (u.hp <= 0 || u.side === side || u.armour) continue;
    const dx = sub(u.x, x), dz = sub(u.z, z);
    if (abs(dx) > bestD || abs(dz) > bestD) continue;
    const d = length2(dx, dz);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * How dangerous a spot is: guns actually in range, normalised.
 *
 * Armour counts one, infantry 0.18 of one, and ten points is maximum danger -
 * the scale measured on the built map, where the seam runs 7 to 13 and the
 * run-in to the gate about 2.
 */
// Fire between the two armies, ported from Army.StepArmour with Flow at zero.
//
// A tank engages the nearest enemy tank inside 46 m, reloads for 1.4 to 3.2
// seconds and takes 1.1 to 2.4 hit points off it - and a tank has 6 to 10, so
// it dies to about five hits over roughly ten seconds. That is the shape the
// recording shows: twenty-four a side down to nineteen by t=15, then a grind
// that neither side wins.
//
// Hit points here are the C# ones times ten, which is what the state buffer
// already holds.
const FIRE_RELOAD_MIN = 84;      // ticks, 1.4 s
const FIRE_RELOAD_SPAN = 108;    // up to 3.2 s
/**
 * How often a shot connects. Near misses are part of the show.
 *
 * StepArmour rolls Random01() < 0.55 before taking anything off the target,
 * and the core took a hit off every shot. That single line is most of why
 * the core kept a third of its armour over a minute where the C# army keeps
 * three quarters - and it was invisible in the constants, because reload,
 * damage and hit points had all been matched exactly.
 *
 * Found by measuring rather than reading: the C# army fights with four to
 * eight enemies in range per tank against the core's 0.3-0.75 and still loses
 * far fewer, which said the fault could not be contact and had to be
 * lethality per shot.
 */
export const HIT_PER_MIL = 550;

const FIRE_DAMAGE_MIN = Math.imul(11, ONE);
const FIRE_DAMAGE_SPAN = Math.imul(13, ONE);

/**
 * One round of armour against armour.
 *
 * `units` is the same accessor threatAt takes; `self` is the index firing.
 * Returns the index it hit, or -1. The caller applies the damage, because the
 * state buffer is the caller's to write.
 */
export function pickTarget(units, count, self, x, z, side) {
  let best = -1, bestD = ARMOUR_RANGE;
  for (let i = 0; i < count; i++) {
    if (i === self) continue;
    const u = units(i);
    if (u.hp <= 0 || u.side === side || !u.armour) continue;
    const dx = sub(u.x, x), dz = sub(u.z, z);
    if (abs(dx) > bestD || abs(dz) > bestD) continue;
    const d = length2(dx, dz);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// The rifle, from Army.StepInfantry. A man reloads for 2.5 to 4.5 seconds
// after a shot and looks again after 0.4 to 1.1 when he has nobody to shoot
// at, and a hit takes one point off a man who has one - so a rifleman dies to
// a single bullet. In this core he carries ten, because the buffer holds hit
// points at ten times C#'s scale.
const RIFLE_RELOAD_MIN = 150;    // ticks, 2.5 s
const RIFLE_RELOAD_SPAN = 120;   // up to 4.5 s
const RIFLE_LOOK_MIN = 24;       // 0.4 s, nothing in range
const RIFLE_LOOK_SPAN = 42;      // up to 1.1 s

export const RIFLE_RELOAD_TICKS = RIFLE_RELOAD_MIN;
export const RIFLE_RELOAD_TICKS_SPAN = RIFLE_RELOAD_SPAN;
export const RIFLE_LOOK_TICKS = RIFLE_LOOK_MIN;
export const RIFLE_LOOK_TICKS_SPAN = RIFLE_LOOK_SPAN;
export const RIFLE_HP = Math.imul(10, ONE);
export const RIFLE_DAMAGE = Math.imul(10, ONE);

export const BACKOFF_RANGE = BACK_OFF_RANGE;
export const RELOAD_MIN = FIRE_RELOAD_MIN;
export const RELOAD_SPAN = FIRE_RELOAD_SPAN;
export const DAMAGE_MIN = FIRE_DAMAGE_MIN;
export const DAMAGE_SPAN = FIRE_DAMAGE_SPAN;

export const THREAT_FOR_FULL = Math.imul(10, ONE);

export function threatAt(units, count, x, z) {
  let threat = 0;
  for (let i = 0; i < count; i++) {
    const u = units(i);
    if (u.hp <= 0) continue;

    // Rejected on each axis before any distance is taken. length2 squares its
    // arguments in Q16.16 and this map is 260 m across, so a unit at the far
    // end overflows the sum of squares past 2^31 and comes back as a distance
    // of zero - which reads as a tank standing on the truck. The same trap the
    // collision walked into.
    const dx = sub(u.x, x), dz = sub(u.z, z);
    if (abs(dx) > ARMOUR_RANGE || abs(dz) > ARMOUR_RANGE) continue;

    const d = length2(dx, dz);
    if (u.armour) { if (d < ARMOUR_RANGE) threat = add(threat, ONE); }
    else if (d < RIFLE_RANGE) threat = add(threat, 11796);   // 0.18
  }
  return clamp(div(threat, THREAT_FOR_FULL), 0, ONE);
}
