// The two armies, ported from Army.cs.
//
// Units hold a line either side of the seam, walk toward it, and shoot at the
// courier when it is in range and worth shooting at. What matters for the score
// is the last part: the count of units actually in range is what "danger"
// means, and it replaced distance-to-a-line for good reason - the frontline is
// defined across the whole map, so a truck on the empty run-in to the gate
// could sit on it and be scored as though under fire.

import { ONE, add, sub, neg, mulFast, div, idiv, clamp, min, max, abs, length2, sqrt } from '../fixed.js';
import { MINER_DOOR_X } from './map.js';
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

/**
 * WHAT THE LOAD BUYS THE WAR, from `Army.cs:625`, `:634` and `:638`.
 *
 * Heat widens the reach the truck is noticed at, lets it outrank a tank that
 * is closer than it is, and multiplies the shell. Heat ZERO is still the C#
 * recording. Full heat used the C# 1.4 / 2.5 / 0.6 factors and covered the
 * whole 85 m half-map (tanks noticed at 81.6 m), so the rim was not a rim
 * and a loaded run could not reach the gate. M1.a16 (the owner 2026-09-07):
 * keep it hard, 30-40% of committed runs should get through.
 *
 * A tank at full heat now notices at 34 x 1.3 = 44.2 m, will leave a foe
 * half again nearer to shoot at the truck, and hits for 5-11 x 1.22. The
 * rifle's round is still not scaled.
 */
export const HEAT_REACH_ARMOUR = 19661;    // 0.3
export const HEAT_REACH_RIFLE = 13107;     // 0.2
export const HEAT_OUTRANK = 32768;         // 0.5
export const HEAT_SHELL = 14418;           // 0.22

/**
 * How far this arm notices the truck at, for a load hunted this hard.
 *
 * The three heat terms are written as three functions rather than inline
 * arithmetic because a rule with three factors needs three tests: with them
 * inline, zeroing the reach and zeroing the shell BOTH left the end-to-end
 * measurements green - the outranking alone carried the whole effect - and a
 * factor no test can kill is a factor nobody is holding.
 */
export const courierReach = (heat, armour) => {
  const base = armour ? COURIER_RANGE : RIFLE_RANGE;
  const per = armour ? HEAT_REACH_ARMOUR : HEAT_REACH_RIFLE;
  return add(base, mulFast(base, mulFast(clamp(heat, 0, ONE), per)));
};

/**
 * Whether the truck outranks the enemy this unit had picked.
 *
 * At heat zero this is the plain "nearer than the foe" the recordings were
 * taken at; at full heat the truck wins from three and a half times as far.
 */
export const outranksTheFoe = (toTruck, toFoe, heat) =>
  toTruck < add(toFoe, mulFast(toFoe, mulFast(clamp(heat, 0, ONE), HEAT_OUTRANK)));

/**
 * What a shell does to a load hunted this hard. The rifle's round is NOT
 * scaled: the C# scales the shell and not the round, and the two damage bands
 * are what a recorder tells the weapons apart by.
 */
export const shellForHeat = (shell, heat) =>
  add(shell, mulFast(shell, mulFast(clamp(heat, 0, ONE), HEAT_SHELL)));
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
// §11.5: a pinned man crawls at 0.5 m/s - one sixth of a walk - toward his claimed place if he has one, else
// toward his post. It is the SAME walk to the SAME target at a sixth of the pace, not a second movement path, and
// at 0.0083 m a tick it sits under §11.4's 0.01 m step probe, so a pinned man is never STAND.
export const RIFLE_CRAWL = 32768;   // 0.5 m/s: 0.0083 m a tick

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

export const RIFLE_STANDOFF = Math.imul(4, ONE);   // §11.3's claim pass measures a man's post from this too
const RIFLE_SPREAD = Math.imul(8, ONE);      // + 0 to 8, so 4 to 12
const RIFLE_SQUAD_Z = Math.imul(10, ONE);    // then -5 to +5
const RIFLE_LEAD_MAX = Math.imul(-8, ONE);   // §12.1 a man's post leads the seam by at most 8 m
const RIFLE_TRAIL_MAX = Math.imul(40, ONE);  // and trails it by at most 40 m

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

/** The post office's paving edge: the army's west kerb (the owner 2026-09-19 13:09, "no tank on the loading dock"). */
export const DOCK_EDGE = 5465702;                  // 83.4 m


/** Inside this, a tank gives ground rather than closing further. */
/** The battlefield's half width, as Army.FrontX has it. */
const FRONT_X = Math.imul(92, ONE);

/**
 * HOW FAR EAST AND WEST A TANK MAY BE, and they are not the same number (2026-09-19 15:58). The army's own edge is
 * FRONT_X - 4 = 88 m. West the post office's paving is nearer, at 83.4 m, so the kerb wins; east the miner's drawn
 * west edge is the door, 108.4 m since the world grew, so the army's own edge wins. Exported because the separation
 * pass in sim.js has to hold the same line - it pushed hulls to 93.7 m while the step was clamped at 88.
 */
export const ARMOUR_WEST = min(sub(FRONT_X, Math.imul(4, ONE)), DOCK_EDGE);
export const ARMOUR_EAST = min(sub(FRONT_X, Math.imul(4, ONE)), sub(MINER_DOOR_X, Math.imul(4, ONE)));

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

/**
 * ARMOUR DOCTRINE (WAR_TACTICS.md, the owner 2026-09-16 18:20): where a tank goes is assigned in `rules/tactics.js` -
 * teams, roles, frontage slots, shoot-and-scoot - and handed in on `u` (tac, tacX, tacDepth, tacBounding). This step only
 * moves the tank there, and picks the hull-down spot for a tank that holds.
 *
 * Measured before (5 seeds x 3600 ticks, truck in the bay): an engaged tank's post was its enemy's x, so every tank
 * facing one enemy steered for the same metre - nearest tank median 8.50 m, the friendly spacing exactly; on 42.5% of
 * tank-ticks the separation push undid the tank's own step; groups of 9 (median) to 20 within 20 m.
 */
const LANE_LEASH = 0;                            // a slot is a position held: the gun reaches 46 m, the hull stays
const HULL_SEARCH = 2;                           // candidates either side of the post, HULL_STEP apart
const HULL_STEP = Math.imul(2, ONE);
const CREST_LOOK = Math.imul(6, ONE);            // how far toward the enemy the crest is looked for
// A TANK WRECK IS A CREST (§4.1, RULED 2026-09-19). To the hull-down search a living-side or enemy TANK wreck counts
// as ground: a candidate whose 6 m toward the enemy crosses the wreck's hull circle reads a rise of WRECK_RISE - a
// hull to the turret ring, more than any plateau (1 m) or ramp, so a hulk beats a candle edge. The 60-tick search
// and the 0.3 m hysteresis above are unchanged, so a wreck moves a tank at most once a second and only by two
// metres. TANK WRECKS ONLY: a truck's wreck is one player's and differs between runs, and a post that read one
// would differ with the truck present and absent, which §1.2 and the A10 row forbid.
export const WRECK_RISE = Math.imul(2, ONE);     // §4.1 what a hulk reads as, hull to the turret ring
export const WRECK_R = Math.imul(3, ONE);        // §1.2 the hull circle a wreck keeps
/**
 * HULL-DOWN (WAR_TACTICS.md §4.1): of the five candidates about an overwatch hold line (-4, -2, 0, +2, +4 m), the one
 * with the largest ground rise 6 m toward the enemy; ties to the first in that scan. Exported because sim.js ranks
 * the half-line budget by how far a tank stands from the place it is really going to.
 */
/**
 * The rise toward the enemy in front of a hold at z (§4.1): the ground CREST_LOOK ahead less the ground under it,
 * or WRECK_RISE when that point stands inside a tank wreck's hull circle. `wreckAt` is optional: without it this is
 * the plain ground reading it has always been.
 */
export function crestRise(z, side, x, ground, wreckAt) {
  const ahead = add(z, Math.imul(-side, CREST_LOOK));
  if (wreckAt && wreckAt(x, ahead)) return WRECK_RISE;
  return sub(ground(x, ahead), ground(x, z));
}

export function hullDownHold(hold, side, x, ground, wreckAt) {
  const toward = Math.imul(-side, CREST_LOOK);
  let best = hold, bestRise = -2147483647;
  for (let c = -HULL_SEARCH; c <= HULL_SEARCH; c++) {
    const z = add(hold, Math.imul(c, HULL_STEP));
    const ahead = add(z, toward);
    // A wreck in front of the candidate reads as WRECK_RISE, whatever the ground under it does (§4.1, 2026-09-19).
    const rise = (wreckAt && wreckAt(x, ahead)) ? WRECK_RISE : sub(ground(x, ahead), ground(x, z));
    if (rise > bestRise) { bestRise = rise; best = z; }
  }
  return best;
}

const POST_DEPTH = ONE;                          // a tank within 1 m of its post's depth stands
const REVERSE_TICKS = 120;                       // §0 row 2: at most one reversal of a tank's own travel in any 2 s
const POST_DEPTH_ARRIVE = ONE >> 2;             // a hull already driving to its line goes on to 0.25 m of it
const POST_SIDE = ONE;                           // and within 1 m of its slot across. It was 2 m: a depth move on a hull
                                                 // up to 30 degrees off drifts x, and correcting half a metre of it
                                                 // flipped the step. But "on post" is ruled as 1.5 m (§0 "Hold is the
                                                 // default"), and 1 m across with the 1 m depth band stays inside it: at
                                                 // 2 m (1830888) 20.2 points of living-pair ticks were a tank standing
                                                 // still inside the band and outside 1.5 m, its bound never counted done.
const POST_SIDE_ARRIVE = ONE >> 1;               // a hull already driving across to its slot goes on to 0.5 m of it
const CROSSING = Math.imul(4, ONE);              // further than this across from its slot, a tank is still crossing
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
// WAR_TACTICS.md §1.1 (the owner 2026-09-16): never inside 12 m, tank to tank, either side - was C#'s 8.5 m friendly and
// 7.5 m hostile, and the measured nearest tank sat at 8.50 m, pressed against it, on half of all tank-ticks.
const FRIENDLY_SPACING = Math.imul(12, ONE);
const HOSTILE_SPACING = Math.imul(12, ONE);
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
/**
 * A POST INSIDE A CRATER IS ON ITS RIM INSTEAD, ON THE TANK'S OWN SIDE (the owner 2026-09-19 15:57,
 * owner-screens/tanks-stuck-craters-1557.jpg: "tanks stuck in craters - they do not move away and cannot attack").
 *
 * Measured before this rule, over 90 s with nukes landing, seeds 1 / 2 / 3: 44.7% / 45.7% / 52.4% of all living
 * tank-ticks were spent within 1.5 m of a crater rim, and 44131 of seed 1's 44193 of those had the tank's POST
 * inside the bowl. The longest unbroken stay on one lip was 68.6 / 68.6 / 73.6 s - a third of a round, standing
 * still. The cause is two rules pulling against each other every tick: the post may lie in a bowl, `AvoidWrecks`
 * (rules/army.js) pushes the hull back out to R + 3.2 m, and the tank walks in again at its own gait. The push is
 * not wrong - a tank does not sit in a hole - so what moves is the POST.
 *
 * The post SLIDES ALONG ITS OWN DEPTH LINE to the nearer edge of the bowl - x only, the line's z untouched - so the
 * hull drives AROUND the hole and keeps its place in the front, instead of standing on the lip. Projecting it
 * radially onto the rim was the first cut and it is not what the owner asked for: measured, it left the tank within
 * 1.5 m of a rim on 36.0 / 29.3 / 26.9% of tank-ticks, because the rim was then the post. Craters are visited in
 * index order and the point is re-checked, because bowls overlap (his shot has three); four passes, then it stands
 * where it is - a bounded loop, so the tick cost cannot run away.
 *
 * Men are NOT projected: §11.3 rules that a man lies in a crater unhurt and is not pushed out of one. This is the
 * armour's post only.
 */
export const CRATER_CLEAR = 445645;               // 6.8 m: AvoidWrecks' 3.2 m push plus the hull's own 3.6 m length

// WHY THE POST IS A HULL-LENGTH CLEAR OF THE PUSH, not level with it: at R + 3.2 m the post IS the push boundary,
// so the tank stands with its constraint always touching - the smallest overshoot re-triggers the push and it
// works its way along the lip. One hull length of daylight (§1.2's 3.6 m half-length) is the smallest distance at
// which the two rules never meet.

export function clearOfCraters(craters, x, z, side) {
  if (!craters || !craters.n) return { x: x | 0, z: z | 0 };
  let px = x | 0;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < craters.n; i++) {
      const c = Math.imul(i, 3);
      const R = craters.r[c + 2];
      if (R <= 0) continue;
      const cx = craters.r[c], cz = craters.r[c + 1], reach = add(R, CRATER_CLEAR);
      const dz = sub(z, cz);
      if (abs(dz) >= reach) continue;                       // the line passes clear of this bowl
      const dx = sub(px, cx);
      if (abs(dx) >= reach) continue;
      // the bowl blocks this line between cx +- span; the post slides to the nearer free edge, so the hull goes
      // AROUND the hole along its own depth line instead of standing on the lip
      const span = sqrt(sub(mulFast(reach, reach), mulFast(dz, dz)));
      if (span <= 0) continue;
      px = dx >= 0 ? add(cx, span) : sub(cx, span);
      moved = true;
    }
    if (!moved) break;
  }
  return { x: px | 0, z: z | 0 };
}

export function stepUnit(u, rng, seamZ, truckX, truckZ, truckHeading, heat, halfX, halfZ, dt, index, tick, craters, ground) {
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
  // FIRE AND MOVEMENT (WAR_TACTICS.md §11.2): the halt clock is the FIRE TEAM's, handed in on `u.halted` by sim.js, so
  // four men rest and halt together. A caller that does not set it gets the man's own clock, as before.
  const still = !u.armour && (u.halted === undefined ? standingStill(index, tick | 0) : u.halted);
  // §11.5: pinned beats the halt clock's zero and beats his own pace - he is going nowhere fast, but a man in the
  // open still crawls toward cover rather than lying in the middle of it.
  const walk = u.armour ? ARMOUR_WALK
             : u.pinned ? RIFLE_CRAWL
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
  const standoff = u.armour
    ? add(ARMOUR_STANDOFF,
          sub(Math.imul(scatter, ARMOUR_SPREAD) >> 10, ARMOUR_SPREAD >> 1))
    : rifleStandoff(index, u.infPush);
  // The side a unit BELONGS to, not the side it happens to be standing on.
  //
  // Taken from the current position, a unit that stepped over the seam had its
  // stand-off flip and was sent back - so armour oscillated across the line
  // instead of holding short of it, and by t=10 the whole force had walked
  // through a front that no longer existed.
  const side = u.side < 0 ? -1 : 1;
  let hold = add(seamZ, Math.imul(side, standoff));
  if (!u.armour && u.cover) hold = u.cover.z;        // §11.3: the claimed place is his line as well as his lane
  let craterX = null;                                // the post's x after a crater projection, if one moved it
  if (u.armour && u.tac) {
    // Measured from the seam at the SLOT, not at the hull: the seam curves with x, and a target that moved as the
    // hull crept across kept it on the edge of its post.
    hold = add(u.tacSeam, mulFast(Math.imul(side, ONE), u.tacDepth));
    // HULL-DOWN, for the overwatch tank: the candidate with the highest ground between it and the enemy.
    // the crest the core holds for this tank (tactics.js crestHold, §4.1 hysteresis), handed in as an offset from the line
    if (!u.tacBounding && ground) hold = add(hold, u.tacCrest | 0);
    // AND NOT INTO A CRATER (the owner 2026-09-19 15:57). A post in a bowl and the AvoidWrecks push below pull against
    // each other every tick, and the hull stands on the lip for as long as the crater lives: measured 44.7 / 45.7 /
    // 52.4% of living tank-ticks within 1.5 m of a rim on seeds 1 / 2 / 3, longest stay 68.6 / 68.6 / 73.6 s. The
    // post goes to the rim on this tank's own side (tactics.js clearOfCraters), so it paths around and keeps firing.
    // `craters` here is the same list the push reads, so the two rules cannot disagree about where a bowl is.
    { const c = clearOfCraters(craters, u.tacX, hold, side); craterX = c.x; hold = c.z; }
  }

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
  // WAR_TACTICS.md §4.10: a tank's overrun is measured from its team's pushed forward line, not the seam - or every
  // push across the seam would be thrown back by this rule on the tick it arrived.
  const overrunFrom = u.armour && u.tac ? add(u.tacSeam, mulFast(Math.imul(side, ONE), u.tacForward)) : seamZ;
  const past = mulFast(sub(u.z, overrunFrom), Math.imul(-side, ONE));
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
  // Bit 5 of a tank's memory word (sim.js U_COOLDOWN): it gave ground and the enemy has not left 30 m since.
  let gaveGround = u.armour && u.crowdedLoose ? ((u.cooldown | 0) >> 5) & 1 : 0;
  if (overrun) {
    const back = u.armour && u.tac
      ? add(u.tacSeam, mulFast(Math.imul(side, ONE), sub(FALL_BACK, u.tacPush)))
      : add(seamZ, Math.imul(side, FALL_BACK));
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
    // THE GROUND GIVEN IS A PLACE TOO (measured 2026-09-19). This band was the step's own length - CROWD_WALK * dt,
    // about 4 cm - so a tank inside a step of its back-off point still stepped a whole step, landed the other side of
    // it and reversed on the next tick. That is the same fault the walk-to-post branch below records fixing with
    // POST_DEPTH ("with the step's own length as the deadband a hull ... left the band, reversed to correct, drifted
    // back"); it was left in this branch. Measured on the six seeds where §0's wiggle row fails, 8 of the 12 fidgets
    // were stepped here, 7 of them within a metre of a hold that had not moved.
    //
    // Same band as the post: a tank within POST_DEPTH of the ground it gave stands. Nothing else changes - the
    // distance given is still BACK_OFF, the pace is still CROWD_WALK, and a tank further out still walks in.
    const want = abs(g) > POST_DEPTH ? (g > 0 ? ONE : -ONE) : 0;
    dz = mulFast(mulFast(CROWD_WALK, want), dt);
    gaveGround = 1;
  } else if (u.armour && u.crowdedLoose && gaveGround && mulFast(sub(u.z, hold), Math.imul(side, ONE)) > 0) {
    // ...AND THEN HOLDS (WAR_TACTICS.md §1.1). A tank that gave ground, with the enemy still inside the 24 m it backed
    // off from plus the 6 m it gave, stands where it is. Without this it stepped out of 24 m, walked back in and backed
    // off again: measured, 23% of the tank direction flips that came twice inside 2 s.
    // ONLY A TANK THAT GAVE GROUND (bit 5 of its memory word, cleared once no enemy is inside 30 m). Read as "any tank
    // short of its post with an enemy inside 30 m" it also stopped every assault: with the slots staggered an enemy hull
    // stands about 27 m from a lane's seam, and tanks posted across the seam stood on 8774 tank-ticks (seeds 1-15).
    dz = 0;
  } else {
    const gap = sub(hold, u.z);
    // A TANK'S POST IS A PLACE, NOT A LINE: within POST_DEPTH of it the tank stands. With the step's own length as
    // the deadband a hull driving sideways to its slot drifted a few centimetres in depth, left the band, reversed
    // to correct, drifted back - measured ~10 heading reversals a tank-second and 16-18% of one-second windows
    // fidgeting.
    // And while it is still crossing to its slot it does not correct its depth at all: the move across comes first,
    // the depth after it arrives. With any band on depth, a hull crossing on a slant drifted over the band's edge
    // and back each tick and swung between two headings 135 degrees apart (measured 3.8 reversals a tank-second).
    const crossing = u.armour && u.tac && abs(sub(u.tacX, u.x)) > CROSSING;
    // ARRIVE ON THE LINE, NOT AT THE EDGE OF THE BAND: a standing tank corrects its depth only past POST_DEPTH; a tank that
    // moved last tick along z toward its hold (bit 0 and its last z sign, sim.js U_COOLDOWN) goes on to 0.25 m. A hull-down
    // hold is the foot of a crest: stopped 1 m short of it, the tank's 6 m look ended on the ramp - 9% of overwatch on-post
    // ticks had 1-1.95 m in front of them instead of 2 m (measured with the berms, withdrawn 2026-09-17 by §4.15 passability).
    const arrivingZ = u.armour && u.tac && ((u.cooldown | 0) & 1) === 1 && (((u.cooldown | 0) >> 1) & 3) === (gap > 0 ? 1 : 2);
    const band = u.armour ? (arrivingZ ? POST_DEPTH_ARRIVE : POST_DEPTH) : mulFast(walk, dt);
    const want = !crossing && abs(gap) > band ? (gap > 0 ? ONE : -ONE) : 0;
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
  // FRONTAGE: a tank holds its team's slot (rules/tactics.js) and closes on its foe only inside LANE_LEASH.
  const lane = u.armour ? (craterX === null ? u.tacX : craterX) : 0;
  // §11.3: a man holding a cover place walks to THE PLACE - it is his post while he holds the claim (tactics.js
  // coverClaims hands it in on `u.cover`). No new speed and no new rule for getting there: it is the same walk to
  // the same kind of target, at his own gait, which is what "the line's post is where he stands when he has no
  // hole" means. Armour never has one: §11.3 is the men's, and the tanks' answer to a bowl is to go around it.
  const post = u.armour
    ? (u.engaged ? add(lane, clamp(sub(u.foeX, lane), neg(LANE_LEASH), LANE_LEASH)) : lane)
    : (u.cover ? u.cover.x : riflePost(anchor, index));
  const dxWant = sub(post, u.x);
  const dxCap = mulFast(walk, dt);
  // What the tank asks for before anything holds it: sim.js keeps a granted move granted until it arrives.
  // ARRIVE ON THE SLOT, NOT AT THE EDGE OF THE BAND: a standing tank starts to correct only past POST_SIDE; a tank that
  // moved last tick along x toward its slot (bit 0 and its last x sign, sim.js U_COOLDOWN) keeps going to 0.5 m.
  const arriving = u.armour && u.tac && ((u.cooldown | 0) & 1) === 1 && (((u.cooldown | 0) >> 3) & 3) === (dxWant > 0 ? 1 : 2);
  const sideBand = arriving ? POST_SIDE_ARRIVE : POST_SIDE;
  u.wantsMove = u.armour && (dz !== 0 || abs(dxWant) > sideBand);
  let dx = u.armour && (u.tacWait || abs(dxWant) <= sideBand) ? 0 : clamp(dxWant, neg(dxCap), dxCap);
  if (u.armour && u.tacWait) dz = 0;       // one of the pair holds: this one waits for its overwatch partner (sim.js)
  // ONE REVERSAL IN TWO SECONDS (WAR_TACTICS.md §0 row 2). A tank's own step may change its x or z sign once; a second
  // change inside REVERSE_TICKS of the first is not taken - the hull stands until two seconds have passed, then goes.
  // Every fidget measured on seeds 1-10 (14 of 442 flips) was a real change of post, a 14 m leg swap and an 8 m push
  // step the other way inside 2 s: the order reversed, and the hull reversed with it. The memory is the tank's own
  // U_COOLDOWN word (sim.js): bit 0 moved last tick, bits 1-2 its last z sign, 3-4 its last x sign, bit 5 it gave
  // ground (above), bit 6 its move is granted (sim.js), bit 7 it has stood on post since it spawned (sim.js), from bit 8
  // the tick of its last reversal.
  if (u.armour && u.tac) {
    const mem = u.cooldown | 0, zWas = (mem >> 1) & 3, xWas = (mem >> 3) & 3;
    let flipped = (mem >>> 8) | 0;
    const recent = ((tick | 0) - flipped) < REVERSE_TICKS;
    let zNow = dz > 0 ? 1 : dz < 0 ? 2 : 0, xNow = dx > 0 ? 1 : dx < 0 ? 2 : 0;
    if (recent && zNow && zWas && zNow !== zWas) { dz = 0; zNow = 0; }
    if (recent && xNow && xWas && xNow !== xWas) { dx = 0; xNow = 0; }
    if ((zNow && zWas && zNow !== zWas) || (xNow && xWas && xNow !== xWas)) flipped = tick | 0;
    u.reverseMemory = (Math.imul(flipped, 256) | (gaveGround << 5) | ((xNow || xWas) << 3) | ((zNow || zWas) << 1)) | 0;
  }

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
  // §11.5 / §4.16: A PINNED MAN CRAWLS 0.5 m/s ALONG HIS DIRECTION OF TRAVEL, not 0.5 m/s on each axis.
  // The gait is a SPEED, so the step vector is scaled to it rather than each axis being capped at it -
  // otherwise a diagonal crawl covers 0.0118 m a tick against an axis crawl's 0.00833, reads over §0's
  // 0.01 m bar, and a pinned man is STAND (WAR_TACTICS §4.16, ruled 2026-09-22). Scaling here rather
  // than slowing diagonals: 0.5 m/s does not move, and a man's speed must not depend on his heading.
  if (!u.armour && u.pinned) {
    const far = length2(stepX, stepZ);
    const cap = mulFast(RIFLE_CRAWL, dt);
    if (far > cap && far > 0) { stepX = div(mulFast(stepX, cap), far); stepZ = div(mulFast(stepZ, cap), far); }
  }
  if (u.armour) {
    const far = length2(dx, dz);
    // WAR_TACTICS.md §4.5: moving, the hull points along its step; standing on its post, at the enemy side (the seam
    // normal), so a held line is a line of guns facing the seam.
    const enemyDir = u.side < 0 ? 0 : 32768;
    const standing = u.tac === true && far <= TURN_FLOOR;
    // A TANK BACKS OFF FACING THE ENEMY: its hull lines up with the line of travel, nose first or tail first,
    // whichever is the shorter turn. Turning round to drive 8 or 14 m back and round again to stand cost two half-turns
    // of standing still, and a hull paused mid-drive by the half-line budget stood with its gun off the seam - 6.15% of
    // holding ticks on the line, most of A7's miss.
    const travel = far > TURN_FLOOR ? atan2(dx, dz) : 0;
    const offNose = (((travel - u.heading + 32768) & 65535) - 32768) | 0;
    const offTail = (((travel + 32768 - u.heading + 32768) & 65535) - 32768) | 0;
    const tailFirst = u.tac === true && abs(offTail) < abs(offNose);
    if (far > TURN_FLOOR || standing) {
      const want = standing ? enemyDir : tailFirst ? (travel + 32768) & 65535 : travel;
      const off = (((want - u.heading + 32768) & 65535) - 32768) | 0;
      u.heading = add(u.heading, Math.imul(off, TURN_RATE) >> 16) & 65535;
    }
    // THE PROJECTION IS NOT GATED, and it used to be. Both lines sat inside
    // the floor above, so below 0.4 m/s a tank kept `dx, dz` - the raw output
    // of two separate controllers - and moved along that instead of along its
    // hull. Measured: 1.4% of armour ticks, and in them the hull sits 89.7
    // degrees from the movement. That is not the turn lag, it is a tank
    // travelling sideways, which is the one thing (x) forbids.
    //
    // The floor is C#'s own - `Army.cs:456` updates the heading only when the
    // step exceeds `dt * 0.4` - but in C# it gates ONLY the heading, because
    // C# has no velocity constraint to gate: its step is always along its goal
    // vector. Gating the core's projection with it copied a guard onto a rule
    // it was never written for. The heading still stops updating below the
    // floor, where the direction of a 6 mm step is noise; the tank still only
    // ever drives where it points.
    // ALONG THE HULL BY THE PROJECTION, not the whole distance: the full `far` laid along a hull that is not pointing
    // at the post overshoots it in depth by the sideways part, and a tank cannot strafe, so it overshot back and
    // forth every tick (measured: path over net distance p90 31, 18% of one-second windows fidgeting). The
    // projection is signed - negative is reversing - and never longer than the move asked for.
    // PIVOT, THEN DRIVE: a hull more than 30 degrees off the way it is going turns where it stands and does not move.
    // Driving along a hull still turning swung the step's sideways part from one sign to the other mid-turn -
    // measured, two thirds of the direction flips that came twice inside 2 s (WAR_TACTICS.md §0 row 2).
    const lined = far > TURN_FLOOR
      ? (tailFirst ? abs(offTail) : abs(offNose)) <= 5461
      : true;
    const along = lined ? add(mulFast(dx, sin(u.heading)), mulFast(dz, cos(u.heading))) : 0;
    stepX = mulFast(sin(u.heading), along);
    stepZ = mulFast(cos(u.heading), along);
  }

  // AND NOT ONTO EITHER BUILDING (the owner 2026-09-19 13:09 and 15:58). The army's own edge is FRONT_X - 4 = 88 m.
  // West, the post office's paving reaches to 83.4 m, so the kerb is nearer than the army's edge and it wins.
  // East, the miner's drawn west edge is the door (map.js MINER_DOOR_X, 108.4 m since the world grew), so the
  // army's own edge is the nearer one there. The clamp is therefore NOT symmetric, and writing it as one number
  // was how tanks came to stand on the miner's deck.
  u.x = clamp(add(u.x, stepX), neg(min(ARMOUR_WEST, halfX)), min(ARMOUR_EAST, halfX));
  u.z = clamp(add(u.z, stepZ), -halfZ, halfZ);

  // OUT OF THE CRATERS - A TANK, AND ONLY A TANK.
  //
  // C# has this rule already and it is not the wrecks: `Army.AvoidWrecks`
  // (`Army.cs:533-552`) pushes a unit out of a circle along the radius by
  // `(r + size) - d`, with 3.2 m for a tank and 0.6 m for a man. Plain metres,
  // no PhysX, no nav mesh, no terrain height - so it ports as it stands, and
  // those two sizes come with it rather than being invented here. The WRECKS
  // stay out; what is taken is the shape of the rule, not the feature whose
  // share of the gap measured zero.
  //
  // THE 0.6 m MAN IS GONE (the owner 2026-09-19, and §11.3's own sentence: the
  // push "no longer applies to a man; it still applies to a tank (3.2 m)").
  // Both sizes were carried across together because they sat on one line in
  // C#, and that was the leftover: C# wrote them when a man in a hole was a
  // man in the way, and §11.3 overrules exactly that. Kept, the two rules
  // fought every tick - a crater place sits 1 m INSIDE the rim (tactics.js
  // COVER_RIM_IN) and the shove put him 0.6 m outside it, so the claim was
  // held and the post was never reached: measured 802 crater claims held and
  // 0 reached, 901 wreck claims held and 3 reached. A man is not a hull; he
  // has no size here, and he lies in the bowl unhurt (fallout is the truck's,
  // §10).
  //
  // A push, not a steer. It is the same class as the map edge two lines above
  // and as `resolveSolids` for the truck: a place a unit may not be, resolved
  // after the step rather than negotiated before it. The TRUCK is deliberately
  // not here - it drives through the bowl, which step 3 measured it can.
  if (craters && u.armour) {
    const size = Math.imul(3, ONE) + 13107;                      // 3.2 m, the hull's
    for (let i = 0; i < craters.n; i++) {
      const c = Math.imul(i, 3);
      const R = craters.r[c + 2];
      if (R <= 0) continue;
      const dx = sub(u.x, craters.r[c]), dz = sub(u.z, craters.r[c + 1]);
      const reach = add(R, size);
      if (abs(dx) > reach || abs(dz) > reach) continue;
      const d = length2(dx, dz);
      if (d >= reach) continue;
      // C#'s own guard, and C#'s own action: `AvoidWrecks` returns when
      // `d2 < 1e-4`, which is the same hundredth of a metre. It is there to
      // keep the divide below from a zero, and nothing more.
      //
      // It carried a push of my own until now - out by `reach` along x - so
      // that a unit standing exactly on the centre could not be left in the
      // bowl. Measured, it never happens: 0 of 345,600 unit-ticks. The reason
      // is in the order, not in luck - the push runs AFTER the step, and a
      // step is 0.04 to 0.11 m, always past the hundredth. So the push was a
      // rule C# does not have, guarding a case that cannot arise, and it is
      // gone rather than kept as decoration.
      if (d < 655) continue;
      u.x = add(u.x, div(mulFast(dx, sub(reach, d)), d));
      u.z = add(u.z, div(mulFast(dz, sub(reach, d)), d));
    }
  }

  // AND THE CLAMP IS THE LAST WORD (measured 2026-09-19): the crater push above runs after the step's own clamp, so
  // a hull pushed off a bowl's edge could end up past the kerb or on the miner's deck - the easternmost tank stood
  // at 92.0 m against an 88 m edge. A rule that other rules may step over is not a rule.
  if (u.armour) u.x = clamp(u.x, neg(min(ARMOUR_WEST, halfX)), min(ARMOUR_EAST, halfX));

  // NOTHING OFF THE TRUCK (the owner 2026-09-16 17:00: "Tanks must NOT react to the truck except by shooting. No
  // dodge. No being pushed. They are much stronger than him; that must be obvious."). The ring that held armour
  // 28 m off the truck (3c4f849), and the cap on it (11ea754), are gone: measured with it, no tank ever stood inside
  // 12 m of a truck held in the battle (0 tank-ticks, 5 seeds x 3 places x 2 beds) because the truck moved them. A
  // tank goes where its own line and its foe send it; the truck that drives into one is the thing pushed
  // (`resolveArmour`), and the gun below is the only way a tank answers the truck.

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
/**
 * A RIFLEMAN'S OWN STAND-OFF FROM THE SEAM (§11.3, §12.1) - the one number his WALK and §11.3's CLAIM PASS must
 * agree on, which is why it lives here and is handed to both rather than written out twice.
 *
 * His post is not the bare RIFLE_STANDOFF: it is that, plus his own scatter, plus his squad's depth, less the mean
 * push of the tank lanes his squad stands in (§12.1), and never more than 8 m past the seam nor 40 m behind it.
 *
 * MEASURED WITH THE TWO SPLIT (2026-09-20, 2 seeds x 40 s): the claim pass was handed a bare RIFLE_STANDOFF about
 * the man's OWN squad anchor while the step walked him to his FIRE TEAM's anchor (§9.2) at this stand-off. The two
 * points stood a median 46.3 m apart; 0.2% of man-ticks were ever within 2 m of the one §11.3 measured from, and
 * 6 of 144 men came within 2 m of it once. So the holes it called "within 12 m of his post" were a median 38.9 m
 * from his feet, and no one arrived: 60.2% of claims ended with the man dead and 27.8% with the place gone first.
 *
 * A second slice of the same hash gives the squad depth, so the man's two offsets are independent of each other
 * the way the C#'s two draws are. Derived from the index and never stored: it must not change from tick to tick,
 * there is no spare word in the unit for it, and it takes no draw.
 */
export function rifleStandoff(index, infPush) {
  const scatter = (Math.imul(index | 0, 2654435761) >>> 20) & 1023;
  const scatter2 = (Math.imul(index | 0, 2654435761) >>> 8) & 1023;
  return clamp(sub(add(add(RIFLE_STANDOFF, Math.imul(scatter, RIFLE_SPREAD) >> 10),
                       sub(Math.imul(scatter2, RIFLE_SQUAD_Z) >> 10, RIFLE_SQUAD_Z >> 1)), infPush | 0),
               RIFLE_LEAD_MAX, RIFLE_TRAIL_MAX);
}

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

const FIRE_DAMAGE_MIN = Math.imul(12, ONE);   // 11 -> 12, about 10% (the owner 2026-09-23)
const FIRE_DAMAGE_SPAN = Math.imul(14, ONE);

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
export const RIFLE_DAMAGE = Math.imul(11, ONE);   // 10 -> 11, about 10%

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
