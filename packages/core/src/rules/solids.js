// What the truck cannot drive through.
//
// The core replaced PhysX for the driving and took the collisions with it:
// the body is kinematic and its transform is written straight from here, so
// nothing in Unity resolves a penetration any more. The truck drove through
// the post office, through the miner, through everything.
//
// The obstacles are uploaded by the host as round setup, the same status as
// the relief - they are the boxes Unity is ACTUALLY colliding with, harvested
// from the scene, rather than a second description of the building that could
// disagree with the first.
//
// Boxes are axis-aligned in XZ, which every static collider in this game is,
// and carry their vertical span so the truck can drive UNDER a doorway lintel
// instead of into it.

import { ONE, add, sub, mulFast, div, clamp, min, max, abs, length2 } from '../fixed.js';

export const BOX_WORDS = 6;   // cx, cz, hx, hz, yLow, yHigh

/** The truck's own shape: two circles, front axle and rear. */
export const BODY_FRONT = 131072;    // +2.0 m along the nose
export const BODY_REAR = -117965;    // -1.8 m
export const BODY_RADIUS = 83558;    // 1.275 m, half the track width

/** How tall the truck stands. Anything starting above this is driven under. */
export const BODY_HEIGHT = 213811;   // 3.26 m

export function noSolids() {
  return { n: 0, box: new Int32Array(0) };
}

/**
 * Pushes one circle out of every box it is inside.
 *
 * Returns the correction as a pair, and the surface it was pushed off, so the
 * caller can kill the velocity going INTO the wall without touching the part
 * running along it - which is what makes a wall something you slide down
 * rather than something you stick to.
 */
function pushOut(s, cx, cz, r, floor, out) {
  out[0] = 0; out[1] = 0;
  let hit = 0;

  for (let i = 0; i < s.n; i++) {
    const b = Math.imul(i, BOX_WORDS);
    const yLow = s.box[b + 4], yHigh = s.box[b + 5];

    // A lintel nine metres up is a doorway, not a wall.
    if (yLow > add(floor, BODY_HEIGHT)) continue;
    if (yHigh < floor) continue;

    const bx = s.box[b], bz = s.box[b + 1];
    const hx = s.box[b + 2], hz = s.box[b + 3];

    // Reject on the axes FIRST, before any distance is computed.
    //
    // Not only for speed. length2 squares its arguments in Q16.16, and the
    // rails around this map are 266 m long, so a box a hundred metres away
    // overflowed the sum past 2^31, wrapped it negative, and came back as a
    // distance of ZERO - which read as the circle sitting dead in the middle
    // of that box. The truck was then ejected from scenery it was nowhere
    // near, and arrived at the western edge of the map half a second after
    // the round began.
    if (abs(sub(cx, bx)) > add(hx, r)) continue;
    if (abs(sub(cz, bz)) > add(hz, r)) continue;

    // Nearest point on the box, then the vector out to the circle.
    const nx = clamp(cx, sub(bx, hx), add(bx, hx));
    const nz = clamp(cz, sub(bz, hz), add(bz, hz));
    let dx = sub(cx, nx), dz = sub(cz, nz);
    const dist = length2(dx, dz);

    if (dist >= r) continue;

    if (dist === 0) {
      // Dead centre: leave along the shortest way out, or the box would
      // decide the direction by rounding noise.
      const left = sub(cx, sub(bx, hx)), right = sub(add(bx, hx), cx);
      const back = sub(cz, sub(bz, hz)), front = sub(add(bz, hz), cz);
      const mx = min(left, right), mz = min(back, front);
      if (mx < mz) { dx = left < right ? -ONE : ONE; dz = 0; }
      else { dx = 0; dz = back < front ? -ONE : ONE; }
      out[0] = add(out[0], mulFast(dx, add(r, mx < mz ? mx : mz)));
      out[1] = add(out[1], mulFast(dz, add(r, mx < mz ? mx : mz)));
      hit = 1;
      continue;
    }

    const push = sub(r, dist);
    out[0] = add(out[0], div(mulFast(dx, push), dist));
    out[1] = add(out[1], div(mulFast(dz, push), dist));
    hit = 1;
  }
  return hit;
}

const _a = new Int32Array(2);
const _b = new Int32Array(2);

/**
 * Keeps the truck out of the solid world.
 *
 * Two circles rather than one: a 6.4 m truck represented by a single circle
 * either clips its own nose through a corner or is too fat to fit a doorway
 * it visibly fits. Front and rear are pushed out separately and the body
 * takes the sum, which also makes it slide along a wall it meets at an angle
 * instead of stopping dead against it.
 */
export function resolveSolids(v, s, fx, fz, floor) {
  if (!s || s.n === 0) return 0;

  const fcx = add(v.x, mulFast(fx, BODY_FRONT)), fcz = add(v.z, mulFast(fz, BODY_FRONT));
  const rcx = add(v.x, mulFast(fx, BODY_REAR)), rcz = add(v.z, mulFast(fz, BODY_REAR));

  const a = pushOut(s, fcx, fcz, BODY_RADIUS, floor, _a);
  const b = pushOut(s, rcx, rcz, BODY_RADIUS, floor, _b);
  if (a === 0 && b === 0) return 0;

  const px = add(_a[0], _b[0]), pz = add(_a[1], _b[1]);
  v.x = add(v.x, px);
  v.z = add(v.z, pz);

  // Kill only the part of the velocity going into the wall. Killing all of it
  // makes a glancing scrape a full stop, which is what a wall must not be.
  const len = length2(px, pz);
  if (len > 0) {
    const nx = div(px, len), nz = div(pz, len);
    const into = add(mulFast(v.vx, nx), mulFast(v.vz, nz));
    if (into < 0) {
      v.vx = sub(v.vx, mulFast(into, nx));
      v.vz = sub(v.vz, mulFast(into, nz));
    }
  }
  return 1;
}
