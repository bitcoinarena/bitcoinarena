// The two armies, ported from Army.cs.
//
// Units hold a line either side of the seam, walk toward it, and shoot at the
// courier when it is in range and worth shooting at. What matters for the score
// is the last part: the count of units actually in range is what "danger"
// means, and it replaced distance-to-a-line for good reason - the frontline is
// defined across the whole map, so a truck on the empty run-in to the gate
// could sit on it and be scored as though under fire.

import { ONE, add, sub, neg, mulFast, div, clamp, min, max, abs, length2 } from '../fixed.js';
import { sin, cos } from '../trig.js';
import { below } from '../rng.js';

export const RIFLE_RANGE = Math.imul(26, ONE);
export const ARMOUR_RANGE = Math.imul(46, ONE);
export const RIFLE_HIT_PER_MIL = 45;        // 0.045 per shot
// Closing speeds, measured off the C# army rather than chosen: it covers
// -77.5 to -43.5 in five seconds with armour and -77.5 to -64.6 with
// infantry. See test/vectors/csharp-army.json.
const ARMOUR_WALK = 445645;      // 6.8 m/s
const RIFLE_WALK = 170394;       // 2.6 m/s

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
const RIFLE_STANDOFF = Math.imul(4, ONE);
const ARMOUR_SPREAD = Math.imul(10, ONE);
const RIFLE_SPREAD = Math.imul(8, ONE);

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
const SQUAD_SPAN = Math.imul(76, ONE);     // anchors run from -76 to +76
const SQUAD_WIDTH = Math.imul(16, ONE);    // each unit sits within 8 m of its anchor
const TWO = Math.imul(2, ONE);

const BACK_OFF_RANGE = Math.imul(24, ONE);
const BACK_OFF = Math.imul(6, ONE);        // metres a second, away from the seam
const OVERRUN = Math.imul(14, ONE);

export const SIDE_BULL = -1;
export const SIDE_BEAR = 1;

/**
 * Advances one unit. `u` is a view object over the state's words.
 *
 * Draw order, and it is protocol: wobble, then - only if in range and the
 * cooldown has expired - reload, then the hit roll. Nothing may be inserted
 * before the wobble or every recorded transcript stops replaying.
 */
export function stepUnit(u, rng, seamZ, truckX, truckZ, halfX, halfZ, dt, index) {
  if (u.hp <= 0) return 0;

  const wobble = (below(rng, 64) - 32) | 0;
  u.heading = (add(u.heading, wobble)) & 65535;

  // Advance on the seam from our own side and hold short of it.
  //
  // The stand-off is what keeps this a front. Walking onto the seam and
  // stopping there puts both armies on one line and the first side with a
  // rounding advantage walks through; holding short leaves a contested strip
  // between them, which is what the C# army does and why its means oscillate
  // about zero for ninety seconds without ever crossing.
  const walk = u.armour ? ARMOUR_WALK : RIFLE_WALK;
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
  const span = u.armour ? ARMOUR_SPREAD : RIFLE_SPREAD;
  const standoff = add(u.armour ? ARMOUR_STANDOFF : RIFLE_STANDOFF,
                       sub(Math.imul(scatter, span) >> 10, span >> 1));
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
  const overrun = past > OVERRUN_DEPTH;

  let dz;
  if (overrun) {
    const back = add(seamZ, Math.imul(side, FALL_BACK));
    const g = sub(back, u.z);
    dz = mulFast(mulFast(walk, g > 0 ? ONE : -ONE), dt);
  } else if (u.crowded) {
    dz = mulFast(mulFast(BACK_OFF, Math.imul(side, ONE)), dt);
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
  const squad = ((index | 0) >> 3) % SQUADS;
  const anchor = sub(Math.imul(squad, div(Math.imul(2, SQUAD_SPAN), Math.imul(SQUADS - 1, ONE))),
                     SQUAD_SPAN);
  const offset = sub(Math.imul((Math.imul(index | 0, 2654435761) >>> 22) & 255,
                               div(SQUAD_WIDTH, Math.imul(255, ONE))), div(SQUAD_WIDTH, TWO));
  const post = add(anchor, offset);
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
  const edge = sub(FRONT_X, Math.imul(4, ONE));
  u.x = clamp(add(u.x, dx), neg(min(edge, halfX)), min(edge, halfX));
  u.z = clamp(add(u.z, dz), -halfZ, halfZ);

  // in range of the courier?
  const d = length2(sub(u.x, truckX), sub(u.z, truckZ));
  if (d >= RIFLE_RANGE) return 0;

  if (u.cooldown > 0) { u.cooldown = (u.cooldown - 1) | 0; return 1; }
  u.cooldown = (40 + below(rng, 60)) | 0;
  return below(rng, 1000) < RIFLE_HIT_PER_MIL ? 2 : 1;   // 2 = a hit landed
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
