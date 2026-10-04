// The air arm, ported from Army.SendHelicopter / StepHelicopters / Release /
// StepBombs / Detonate, and from Battlefield.LaunchSorties.
//
// Ported against test/vectors/csharp-gunships.json rather than against the C#
// read out loud, and the recording changed what this file is. Battlefield's own
// comment calls a sortie "an event you look up for"; measured, a gunship is
// airborne 69-93% of the round and two are up at a time on every seed, because
// both clocks start at zero and a 17 s cadence against a ~10 s transit is
// continuous cover. Air is weather. The numbers below are chosen to reproduce
// that, not the comment.
//
// Two behaviours here look like faults and are COPIED deliberately, because the
// recording is the specification:
//
//   the release gate is on where the bomb is LET GO, not where it lands. A bomb
//   inherits 30 m/s along the gunship's own track and falls from 19 m, so it is
//   thrown some sixty metres downrange; released at |x| < 92 it reaches |x| =
//   148-154 against a field that ends at 92. 26-42% of every load lands on
//   nobody by construction. Narrowing the gate would "fix" a third of the air
//   war out of existence.
//
//   the first sortie of every round is wasted. Both clocks start at zero, so
//   two gunships launch on tick one, and both armies are still at |z| = 77 with
//   the seam between them. The first killing bomb is at t = 16.7-26.4 s.
//
// What is NOT copied is the one thing that would have made the core
// unverifiable: SendHelicopter draws its direction from UnityEngine.Random and
// LaunchSorties draws its jitter from UnityEngine.Random, so the C# air arm
// cannot be replayed from an army seed at all. Here every draw comes off the
// state's own stream, in a fixed order, like everything else in the core.

import { ONE, HALF, add, sub, neg, mulFast, div, clamp, abs, length2, sqrt } from '../fixed.js';
import { sin } from '../trig.js';
import { below, between } from '../rng.js';

/**
 * How far out a gunship may fly, and where it enters. Army.AirCorridorX.
 *
 * 104 rather than the map edge because the two depots are not scenery a
 * helicopter can pass through: the post office stands to x = -114.4 and the
 * miner's leading face is at 108.4. A gunship holds 19 m and both buildings are
 * taller than that.
 */
export const CORRIDOR_X = Math.imul(104, ONE);

/** The drop gate. Army.FrontX - the box the two armies are held inside. */
export const DROP_GATE_X = Math.imul(92, ONE);

/** 20 m/s, and StepHelicopters' comment explains the number. */
const HELI_SPEED = Math.imul(20, ONE);

/**
 * How far off the seam a gunship stands, and how far it weaves either way.
 * `26 + sin(t * 0.6) * 9` on its own side of the line.
 */
const STANDOFF = Math.imul(26, ONE);
const WEAVE_Z = Math.imul(9, ONE);

/** Height held over the ground, and its own slower weave. */
const HEIGHT = Math.imul(19, ONE);
const WEAVE_Y = Math.imul(3, ONE);

/**
 * The two weave rates, converted from radians a second to TURNS a second.
 *
 * Mathf.Sin takes radians; this core's sin takes Q16.16 turns, which is what
 * makes wrapping a free mask and removes every question about pi. 0.6 rad/s is
 * 0.6/2pi = 0.0954930 turns/s and 0.9 rad/s is 0.1432394, and those are the
 * numbers written here in Q16.16. Getting this wrong is not a rounding error -
 * it is a gunship weaving six times too fast.
 */
const WEAVE_Z_RATE = 6258;                 // 0.6 rad/s in turns/s
const WEAVE_Y_RATE = 9387;                 // 0.9 rad/s in turns/s

/**
 * How hard the gunship chases the z it wants: Speed * dt * 1.6 per tick.
 */
const Z_CHASE = 104858;                    // 1.6

/**
 * The height smoothing, `1 - exp(-2 * dt)`, evaluated ONCE for the fixed tick.
 *
 * exp is not on the guard's whitelist and never will be - it is exactly the
 * kind of libm call that differs between engines, which is what specified.test
 * exists to demonstrate. It does not need to be: dt is a constant here, so
 * 1 - exp(-2 * dt) is a constant too. Written out rather than computed, so
 * there is nothing for a second implementation to disagree about.
 *
 * Against the TICK the core actually runs, not against a sixtieth: TICK_DT is
 * 1092, which is 0.0166626 and not 0.0166667, and the two round to different
 * numbers here. Writing 1 - exp(-2/60) gave 2149 where the tick asks for 2148 -
 * a constant that looked derived and was not.
 *
 * If TICK_DT ever changes, this changes with it, and a comment is not enough -
 * test/rules.test.js pins the pair.
 */
export const Y_LERP = 2148;                // 1 - exp(-2 * 1092/65536)

/**
 * 9.81 m/s/s. Bombs are the only thing in this core that falls.
 *
 * Named for the bomb rather than for the world, and NOT shared with the
 * identical constant in vehicle.js. Two reasons, and the second is the one that
 * bit: the truck's is a slope term and this is a trajectory, so they agree by
 * physics rather than by contract - and the bundler concatenates every rule
 * module into ONE scope, where two files declaring `GRAVITY` is a redeclaration.
 * That threw here, loudly, because both are `const`. terrain.js and cargo.js
 * already both declare COLUMNS, with the values 128 and 2, and only escape
 * because neither is reachable from sim.js. bundle.js refuses duplicate
 * EXPORTED names and says why; it does not look at private ones, and a `var` or
 * a `function` colliding there would not throw at all - it would quietly ship a
 * different program. Worth widening, and not in this item.
 */
const BOMB_GRAVITY = 642908;

/** The speed a bomb inherits along the gunship's track, and its aim across the seam. */
const BOMB_VX = Math.imul(30, ONE);
const BOMB_VZ_MIN = Math.imul(10, ONE);
const BOMB_VZ_MAX = Math.imul(22, ONE);

/** How long after entering, and then between drops. Rand(1.5,4) then Rand(1.6,3.2). */
const FIRST_DROP_MIN = Math.imul(3, HALF);       // 1.5 s
const FIRST_DROP_MAX = Math.imul(4, ONE);
const NEXT_DROP_MIN = 104858;                    // 1.6 s
const NEXT_DROP_MAX = 209715;                    // 3.2 s

/**
 * Army.BombRadius, and it is the reason bombs outkill rifles by a distance.
 *
 * Sixteen metres is wider than a squad stands - SQUAD_WIDTH is 16 - so a bomb
 * on a post takes the post. Measured: 60-76 riflemen a round to bombs against
 * 16-37 to rifles, and up to 23 men on one bomb.
 */
export const BOMB_RADIUS = Math.imul(16, ONE);

/**
 * What a bomb does to armour at the centre of the blast, on the core's hit
 * point scale.
 *
 * C# is `v.hp -= 12f * falloff` against hp of Rand(6,10); this core holds hit
 * points at ten times that, so twelve becomes a hundred and twenty. A tank at
 * the centre dies outright and one eight metres out takes half - which is why
 * the armour share is the mirror of the infantry one: 9-12 tanks of 55-63 lost,
 * 15-22%, where infantry is nearly all of it.
 */
export const BOMB_DAMAGE = Math.imul(120, ONE);

/** Battlefield.sortieSeconds, and its jitter. 17 s * [0.7, 1.4). */
export const SORTIE_SECONDS = Math.imul(17, ONE);
const JITTER_MIN = 45875;                        // 0.7
const JITTER_MAX = 91750;                        // 1.4

/** stepHeli's answer. Never both: the gate is |x| < 92 and the exit is |x| > 104. */
export const AIR_NOTHING = 0, AIR_RELEASE = 1, AIR_GONE = 2;

/**
 * Where a gunship of `side` enters, and which way it runs.
 *
 * `dir` is drawn first and the entry x follows from it, because a gunship
 * arrives from beyond the fighting rather than appearing over it. The drop
 * delay is drawn second. That order is protocol.
 *
 * The C# takes dir off UnityEngine.Random, which is why its air arm cannot be
 * replayed from an Army seed; here it comes off the round's own stream.
 */
export function launchHeli(h, rng, side, seamAt, groundAt) {
  const dir = below(rng, 2) === 0 ? ONE : neg(ONE);
  h.dir = dir;
  h.side = side;
  h.x = dir > 0 ? neg(CORRIDOR_X) : CORRIDOR_X;
  h.dropIn = between(rng, FIRST_DROP_MIN, FIRST_DROP_MAX);
  // Dir - the way it faces and pushes - is the OPPOSITE of side: the Bull army
  // is side -1 and its Dir is +1. So `front - Dir * 26` is `front + side * 26`,
  // which puts each gunship 26 m onto its own ground. Writing this with side
  // where C# writes Dir is the sign error that cost item 2c a round.
  h.z = add(seamAt(h.x), Math.imul(side, STANDOFF));
  h.y = add(groundAt(h.x, h.z), HEIGHT);
  h.t = 0;
}

/**
 * One tick of a gunship. `h` is a view over its state words.
 *
 * Draw order: the drop delay, and only when a bomb is actually released. The
 * bomb's own aim is drawn in releaseBomb, immediately after - so a sortie's
 * draws are delay, aim, delay, aim, and a verifier that reorders them gets
 * another air war.
 *
 * Yaw and bank are deliberately absent. They are smoothing on a mesh: nothing
 * downstream reads them, and putting them in the hashed state would put two
 * Mathf.LerpAngle calls into the protocol for the sake of how a model tilts.
 * Height is not scenery and is here - it decides how long a bomb falls, and
 * therefore how far downrange the 30 m/s throws it.
 */
export function stepHeli(h, rng, seamAt, groundAt, dt) {
  h.t = add(h.t, dt);

  h.x = add(h.x, mulFast(mulFast(h.dir, HELI_SPEED), dt));

  // Chased, not snapped: the gunship leans onto the line it wants at 1.6 times
  // its own forward speed, so a moving seam bends the track instead of teleporting it.
  const wantZ = add(seamAt(h.x),
                    Math.imul(h.side, add(STANDOFF, mulFast(sin(mulFast(h.t, WEAVE_Z_RATE)), WEAVE_Z))));
  const reach = mulFast(mulFast(HELI_SPEED, dt), Z_CHASE);
  h.z = add(h.z, clamp(sub(wantZ, h.z), neg(reach), reach));

  const wantY = add(add(groundAt(h.x, h.z), HEIGHT),
                    mulFast(sin(mulFast(h.t, WEAVE_Y_RATE)), WEAVE_Y));
  h.y = add(h.y, mulFast(sub(wantY, h.y), Y_LERP));

  // Drop on what it passes, but only over the box the armies are held in.
  //
  // The gate is on the RELEASE POINT and the bomb is not released where it
  // lands. That is not an oversight to tidy up on the way past: it is 26-42% of
  // every load, measured, and the recording is what this file is held to.
  h.dropIn = sub(h.dropIn, dt);
  if (h.dropIn <= 0 && abs(h.x) < DROP_GATE_X) {
    h.dropIn = between(rng, NEXT_DROP_MIN, NEXT_DROP_MAX);
    return AIR_RELEASE;
  }

  if (abs(h.x) > CORRIDOR_X) return AIR_GONE;
  return AIR_NOTHING;
}

/**
 * A bomb leaves the rack. `b` is a view over a free bomb's state words.
 *
 * It keeps the aircraft's height and its speed along the track, and is aimed
 * across the seam at 10-22 m/s. Nothing steers it after this.
 */
/**
 * How long the bomb falls, in seconds, from a height above the ground.
 *
 * `vy` starts at zero and only gravity acts, so `h = g t^2 / 2` and
 * `t = sqrt(2h/g)`. It is needed because the bomb has exactly ONE free axis:
 * `vx` is inherited from the aircraft and nothing steers it afterwards, so
 * where it lands in x is already decided at the moment of release and only z
 * can be aimed. Knowing t turns "aim at that clump" into a speed.
 */
export const fallTime = (above) =>
  above <= 0 ? 0 : sqrt(div(Math.imul(2, above), BOMB_GRAVITY));

/**
 * `aimZ` is where the bomb should come down, or `NO_AIM` for the old rule.
 */
export const NO_AIM = -2147483648;

export function releaseBomb(b, h, rng, front, aimZ, ground) {
  b.side = h.side;
  b.x = h.x; b.y = h.y; b.z = h.z;
  b.vx = mulFast(h.dir, BOMB_VX);
  b.vy = 0;

  // THE DRAW STAYS. It is protocol: the transcript is the sequence of draws,
  // so the speed is drawn whether or not the aimed branch uses it.
  const drawn = between(rng, BOMB_VZ_MIN, BOMB_VZ_MAX);

  if (aimZ === NO_AIM) {
    // Nothing worth hitting was within reach. Mathf.Sign is +1 at exactly
    // zero, which the core's sign() is not - it returns 0, and a bomb with no
    // lateral speed would fall straight down onto the gunship's own line every
    // time the seam passed under it.
    b.vz = mulFast(sub(front, b.z) >= 0 ? ONE : neg(ONE), drawn);
    return;
  }

  // AIMED. The bomb keeps its own speed band - 10 to 22 m/s is what a bomb
  // released from this aircraft does, and widening it to reach further would
  // be inventing a weapon rather than aiming one. So the crossing speed is the
  // one that puts it on the clump, clamped into that band; a clump beyond the
  // band's reach is undershot rather than teleported to.
  const t = fallTime(sub(b.y, ground));
  const want = t > 0 ? div(sub(aimZ, b.z), t) : 0;
  const dir = want >= 0 ? ONE : neg(ONE);
  b.vz = mulFast(dir, clamp(abs(want), BOMB_VZ_MIN, BOMB_VZ_MAX));
}

/** One tick of a falling bomb. True once it is at or below the ground. */
export function stepBomb(b, ground, dt) {
  b.vy = sub(b.vy, mulFast(BOMB_GRAVITY, dt));
  b.x = add(b.x, mulFast(b.vx, dt));
  b.y = add(b.y, mulFast(b.vy, dt));
  b.z = add(b.z, mulFast(b.vz, dt));
  return b.y <= ground;
}

/**
 * What the blast is worth to armour `d` metres from the centre: 12 * (1 - d/16)
 * on the C# scale, a hundred and twenty on this one.
 *
 * Infantry does not go through this. A bomb does not wound a rifleman, it
 * clears the circle - everyone inside dies whatever the distance - and that
 * flatness is why one bomb is worth up to twenty-three men.
 */
export function bombDamage(d) {
  if (d >= BOMB_RADIUS) return 0;
  return mulFast(BOMB_DAMAGE, sub(ONE, div(d, BOMB_RADIUS)));
}

/** Distance from a blast to a point, both Q16.16. Rejected per axis first. */
export function blastReach(dx, dz) {
  if (abs(dx) > BOMB_RADIUS || abs(dz) > BOMB_RADIUS) return -1;
  const d = length2(dx, dz);
  return d > BOMB_RADIUS ? -1 : d;
}

/**
 * How long until this side's next sortie: 17 s * [0.7, 1.4), so 11.9 to 23.8.
 *
 * The measured intervals across the four recorded seeds are 12.5 to 23.3, which
 * is this distribution and not the "twenty-odd seconds" the comment claims.
 */
export const sortieWait = (rng) => mulFast(SORTIE_SECONDS, between(rng, JITTER_MIN, JITTER_MAX));
