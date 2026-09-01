// The two armies, ported from Army.cs.
//
// Units hold a line either side of the seam, walk toward it, and shoot at the
// courier when it is in range and worth shooting at. What matters for the score
// is the last part: the count of units actually in range is what "danger"
// means, and it replaced distance-to-a-line for good reason - the frontline is
// defined across the whole map, so a truck on the empty run-in to the gate
// could sit on it and be scored as though under fire.

import { ONE, add, sub, mulFast, div, clamp, min, max, abs, length2 } from '../fixed.js';
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
const ARMOUR_STANDOFF = Math.imul(9, ONE);
const RIFLE_STANDOFF = Math.imul(4, ONE);
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
export function stepUnit(u, rng, seamZ, truckX, truckZ, halfX, halfZ, dt) {
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
  const standoff = u.armour ? ARMOUR_STANDOFF : RIFLE_STANDOFF;
  // The side a unit BELONGS to, not the side it happens to be standing on.
  //
  // Taken from the current position, a unit that stepped over the seam had its
  // stand-off flip and was sent back - so armour oscillated across the line
  // instead of holding short of it, and by t=10 the whole force had walked
  // through a front that no longer existed.
  const side = u.side < 0 ? -1 : 1;
  const hold = add(seamZ, Math.imul(side, standoff));

  const gap = sub(hold, u.z);
  const want = abs(gap) > mulFast(walk, dt) ? (gap > 0 ? ONE : -ONE) : 0;
  const dz = mulFast(mulFast(walk, want), dt);
  const dx = mulFast(mulFast(walk, sin(u.heading)), mulFast(dt, 26214));

  u.x = clamp(add(u.x, dx), -halfX, halfX);
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
