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

import { ONE, add, sub, neg, mulFast, div, clamp, min, max, abs, length2 } from '../fixed.js';
import { sin, cos } from '../trig.js';

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

/**
 * How wide a tank is to drive into.
 *
 * Three metres, which is a hull, not the whole vehicle: a tank stops the truck
 * where its armour is, and a slightly generous circle around a 7 m hull would
 * have the truck bouncing off thin air beside it.
 */
export const ARMOUR_RADIUS = 196608;

/**
 * THE HULL IS A HULL (§1.2, RULED 2026-09-19 from the owner's 12:58 playtest shots).
 *
 * The circle above was a compromise and the comment beside it says so - "a slightly generous circle around a 7 m
 * hull would have the truck bouncing off thin air beside it". Measured from the shots and the renderer: the drawn
 * tank is a box of 3.6 m across by 7.2 m long (ArmyRenderer.MakeTankFromPrefab), so head-on the 3.0 m circle fires
 * with the truck's front edge 0.6 m INSIDE the drawn nose - a quarter of the truck buried in the tank before the
 * core says WRECKED - while from the flank it fires 1.2 m BEFORE the meshes meet. One circle cannot be both: the
 * hull is twice as long as it is wide.
 *
 * So the contact is the hull's own rectangle, turned with the tank, and it is the SAME rectangle the client already
 * draws - the two now match by construction and no tank is redrawn. Fitting the mesh to the circle instead would
 * have shrunk every tank from 7.2 m to 5.4 m AND made the flank worse, 1.66 m of thin air.
 */
export const ARMOUR_HALF_W = 117965;   // 1.8 m across the tracks, half of the drawn 3.6
export const ARMOUR_HALF_L = 235930;   // 3.6 m nose to tail, half of the drawn 7.2

/**
 * Keeps the truck out of the armour.
 *
 * The tanks are the HOST'S, not the core's own.
 *
 * The core simulates ninety-six units of its own, and for a while the truck
 * was being kept out of those - which are invisible. The tanks the player can
 * see belong to Unity's Battlefield, somewhere else entirely, so the truck
 * drove straight through everything on screen while colliding perfectly with
 * ghosts. Two armies, and the collision was against the wrong one.
 *
 * Until the army itself moves into the core, its positions are host input:
 * uploaded every tick, recorded with the rest of the input, and replayable
 * from the transcript exactly like a steering command.
 *
 * Infantry are deliberately NOT here. A man does not stop a laden truck, and
 * making him do it turns a charge across the open into a wall of bodies.
 */
export function resolveArmour(v, xz, count, headings) {
  let touched = 0;
  let sumX = 0, sumZ = 0;   // px and pz are already the tank's position
  for (let i = 0; i < count; i++) {
    const px = xz[Math.imul(i, 2)], pz = xz[add(Math.imul(i, 2), 1)];
    // THE HULL'S OWN RECTANGLE, turned with the tank (§1.2, 2026-09-19). Without a heading - a host that supplies
    // positions only - this falls back to the circle it always was, so nothing that fed the old shape breaks.
    const h = headings ? headings[i] : null;
    const fx = h === null ? 0 : sin(h), fz = h === null ? 0 : cos(h);
    const reach = add(h === null ? ARMOUR_RADIUS : ARMOUR_HALF_L, BODY_RADIUS);

    for (const off of [BODY_FRONT, BODY_REAR]) {
      const cx = add(v.x, mulFast(v.fx, off)), cz = add(v.z, mulFast(v.fz, off));
      let dx = sub(cx, px), dz = sub(cz, pz);
      if (abs(dx) > reach || abs(dz) > reach) continue;      // cheap reject, and no overflow

      let d, nx, nz;
      if (h === null) {
        d = length2(dx, dz);
        if (d >= add(ARMOUR_RADIUS, BODY_RADIUS)) continue;
        if (d === 0) { dx = ONE; dz = 0; }
        nx = d === 0 ? ONE : div(dx, d), nz = d === 0 ? 0 : div(dz, d);
        const pushC = sub(add(ARMOUR_RADIUS, BODY_RADIUS), d === 0 ? 0 : d);
        sumX = add(sumX, mulFast(nx, pushC));
        sumZ = add(sumZ, mulFast(nz, pushC));
      } else {
        // the body circle's centre in the hull's own frame: +z along the barrel, +x across the tracks
        const lx = sub(mulFast(dx, fz), mulFast(dz, fx));
        const lz = add(mulFast(dx, fx), mulFast(dz, fz));
        // nearest point on the hull box to that centre, and the gap to it
        const qx = clamp(lx, neg(ARMOUR_HALF_W), ARMOUR_HALF_W);
        const qz = clamp(lz, neg(ARMOUR_HALF_L), ARMOUR_HALF_L);
        let ox = sub(lx, qx), oz = sub(lz, qz);
        d = length2(ox, oz);
        if (d >= BODY_RADIUS) continue;                       // outside the hull's own skin: no touch
        if (d === 0) {                                        // centre inside the hull: out the nearest face
          const toW = sub(ARMOUR_HALF_W, abs(lx)), toL = sub(ARMOUR_HALF_L, abs(lz));
          if (toW <= toL) { ox = lx < 0 ? neg(ONE) : ONE; oz = 0; } else { ox = 0; oz = lz < 0 ? neg(ONE) : ONE; }
        }
        const inv = d === 0 ? ONE : div(ONE, d);
        const ux = d === 0 ? ox : mulFast(ox, inv), uz = d === 0 ? oz : mulFast(oz, inv);
        // back to the world: the hull's axes again, the other way round
        nx = add(mulFast(ux, fz), mulFast(uz, fx));
        nz = sub(mulFast(uz, fz), mulFast(ux, fx));
        const pushB = sub(BODY_RADIUS, d);
        sumX = add(sumX, mulFast(nx, pushB));
        sumZ = add(sumZ, mulFast(nz, pushB));
      }

      const into = add(mulFast(v.vx, nx), mulFast(v.vz, nz));
      if (into < 0) {
        // How hard it went in, before the velocity is taken off it. The host
        // applies its own rule to this - the core's job is to notice.
        const hit = neg(into);
        if (hit > v.impact) v.impact = hit;
        v.vx = sub(v.vx, mulFast(into, nx));
        v.vz = sub(v.vz, mulFast(into, nz));
      }
      touched = 1;
    }
  }

  // The total correction is capped.
  //
  // Two circles against a crowd of tanks produce several ways out at once, and
  // summing them all is how a truck gets wedged: pushed north by one and east
  // by the next until the corrections cancel the controls entirely. Backing
  // out of a jam moved it four and a half metres in five seconds where it
  // should have covered twenty. A cap per tick lets the deepest contact win
  // and leaves the driver in charge of the rest.
  const total = length2(sumX, sumZ);
  if (total > CORRECTION_CAP) {
    sumX = div(mulFast(sumX, CORRECTION_CAP), total);
    sumZ = div(mulFast(sumZ, CORRECTION_CAP), total);
  }
  v.x = add(v.x, sumX);
  v.z = add(v.z, sumZ);
  return touched;
}

/**
 * Most the collision may move the truck in one tick: 0.6 m.
 *
 * It has to exceed the distance the truck covers in a tick, or a fast
 * approach simply pushes through: at 24 m/s that is 0.4 m, and a cap of 0.25
 * let the truck drive into a tank and out the other side.
 */
const CORRECTION_CAP = 39322;
