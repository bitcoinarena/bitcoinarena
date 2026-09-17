// HULL-DOWN EMPLACEMENTS - WAR_TACTICS.md §4.1 "default hold = hull-down: turret over crest, hull hidden".
//
// Measured on the round's relief (tools/measure-hulldown-killzone.mjs, 5874630): not one metre of the seam band has a
// 2 m crest in the 6 m in front of it (0 of 42350 spots on each of seeds 1-5, highest 1.95 m), so an overwatch tank
// took the best crest there was on 96.7% of its ticks and still had its hull in the open on 100% of them. §4.15 says
// what hides a hull: "two metres hides a hull (3 m) to the turret", on a 5 m ramp (40%, 22 degrees).
//
// So each side has an EMPLACEMENT in every one of its seven slot lanes: a berm whose near foot is the resting overwatch
// line - 30 m behind the seam, where the overwatch of every lane stands on most of its on-post ticks - rising 5 m to
// 2.4 m above the ground, flat 4 m, down 5 m. The hull-down search (army.js) finds a 2 m rise 6 m in front
// of the line's candidate and holds it: hull behind the berm, turret over it. The height is taken from the ground at
// the foot, so a hill falling away toward the enemy does not eat the 2 m (it did: 17% of overwatch ticks with the berm
// in front had a crest of 0.9-1.9 m). Across x it covers the pair (hulls at +-6 m, 1.8 m half-width) flat to 8 m of the
// slot centre and eases out by 11 m, 5 m of flat ground between lanes. It stays full height to 83 m from the centre and
// fades out by 86 m, where the aprons are levelled, so no bay stands on a slope and the outer lanes' inner hulls are
// covered (fading with the relief's own ease from 66 m left 29% of overwatch ticks, the outer lanes, without one).
//
// A height LAYER, like the craters: `surfaceAt = relief + emplacements - craters`. The relief itself is untouched, so
// the objectives (§4.11, read from the relief) do not move. It follows the seam at each x, read from the round's tape. Integers only; no draw; nothing reads the truck.
import { ONE, add, sub, abs, mulFast, div, idiv, clamp } from '../fixed.js';
import { frontlineZ } from './frontline.js';
import { heightAtWorld } from './ground.js';
import { slotX, SLOTS_PER_SIDE } from './tactics.js';
import { levelled } from './candles.js';

// 2.4 m, not 2: a hull stands anywhere within 1.5 m of its hold (on post), and at exactly 2 m a tank a few centimetres up
// the ramp saw 1.96 m (37.9% of the served overwatch ticks). 2.4 m hides a 3 m hull to its turret from 29.25 m to 31 m
// behind the seam and still leaves the turret over the crest; the ramp is 48%, under the relief's own 55%.
export const BERM_HEIGHT = 157286;              // 2.4 m in Q16.16 (2.4 x 65536 = 157286.4)
const RAMP = Math.imul(5, ONE);
const TOP = Math.imul(4, ONE);
const FOOT_BEHIND_LINE = ONE >> 1;           // the foot 0.5 m in front of the line: a hull on the line is behind it
const LINE_REST = Math.imul(30, ONE);        // §2.5 overwatch line at push 0
const HALF_TOP_X = Math.imul(8, ONE);
const HALF_FOOT_X = Math.imul(11, ONE);
const FULL_X = Math.imul(83, ONE), NONE_X = Math.imul(86, ONE);
const PITCH = Math.imul(27, ONE);

/**
 * The emplacement height at a world point, Q16.16 metres; 0 off every berm. `ground` is the round's relief grid.
 */
export function emplacementAt(x, z, tape, ground, halfX, halfZ, apron, taken = 0) {
  // `apron` given: the relief as the surface reads it, levelled in the chart band (§4.15)
  const relief = (px, pz) => (apron === undefined ? heightAtWorld(ground, px, pz, halfX, halfZ)
                                                  : levelled(heightAtWorld(ground, px, pz, halfX, halfZ), apron, px, pz, ground, halfX, halfZ));
  const ax = abs(x);
  if (ax >= NONE_X) return 0;
  const first = slotX(0);
  const lane = clamp(idiv(add(sub(x, first), PITCH >> 1), PITCH), 0, SLOTS_PER_SIDE - 1);
  const dx = abs(sub(x, slotX(lane)));
  if (dx >= HALF_FOOT_X) return 0;
  // Every lane at the resting 30 m line: an objective lane's +8 rest (22 m) was measured to hold only 7% of its overwatch
  // ticks - the push steps only from post on a confirmed verdict - and a 22 m berm left 22.1% of all overwatch on-post
  // ticks standing at 30 m with no crest in front.
  const line = LINE_REST;
  const seam = frontlineZ(tape, x, halfX, halfZ, taken);
  const off = sub(z, seam), side = off < 0 ? -1 : 1, depth = abs(off);   // metres behind the seam on that side
  const foot = sub(line, FOOT_BEHIND_LINE);
  const up = sub(foot, RAMP), down = sub(up, TOP), far = sub(down, RAMP);
  if (depth >= foot || depth <= far) return 0;
  const fz = depth > up ? div(sub(foot, depth), RAMP) : depth >= down ? ONE : div(sub(depth, far), RAMP);
  const fx = dx <= HALF_TOP_X ? ONE : div(sub(HALF_FOOT_X, dx), sub(HALF_FOOT_X, HALF_TOP_X));
  const fend = ax <= FULL_X ? ONE : div(sub(NONE_X, ax), sub(NONE_X, FULL_X));
  // 2 m above the HIGHER of the ground at its foot and the relief at its top: a hill climbing toward the enemy neither
  // eats the 2 m nor outscores the berm in the hull-down search (measured: relief rising 0.4 m per metre left a hull at
  // the foot with 1.6 m in front, and the search moved to the slope).
  const footGround = relief(x, add(seam, Math.imul(side, foot)));
  const topGround = relief(x, add(seam, Math.imul(side, up)));
  const base0 = footGround > topGround ? footGround : topGround;
  const here = relief(x, z);
  const want = sub(add(base0, mulFast(BERM_HEIGHT, fz)), here);
  if (want <= 0) return 0;
  return mulFast(mulFast(want, fx), fend);
}
