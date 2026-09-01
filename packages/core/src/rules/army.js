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
const WALK = 3200;
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

  // walk toward the seam, overrunning it a little, then hold
  const gap = sub(seamZ, u.z);
  const want = abs(gap) > OVERRUN ? (gap > 0 ? ONE : -ONE) : 0;
  const dz = mulFast(mulFast(WALK, want), dt);
  const dx = mulFast(mulFast(WALK, sin(u.heading)), mulFast(dt, 26214));

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
    const d = length2(sub(u.x, x), sub(u.z, z));
    if (u.armour) { if (d < ARMOUR_RANGE) threat = add(threat, ONE); }
    else if (d < RIFLE_RANGE) threat = add(threat, 11796);   // 0.18
  }
  return clamp(div(threat, THREAT_FOR_FULL), 0, ONE);
}
