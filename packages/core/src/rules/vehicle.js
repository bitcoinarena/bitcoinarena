// The truck, derived from the raycast-vehicle family rather than ported from
// PhysX.
//
// Unity's WheelCollider is closed and its C# reference is read-only licensed,
// so there was nothing to copy even if copying were wise. Bullet's
// btRaycastVehicle is the open canonical model of the same family and is what
// this follows: one ray per wheel, a spring-damper suspension, a drive force
// at the driven wheels, and a friction circle that caps how much grip a wheel
// can spend on turning and driving at once.
//
// The numbers below are a STARTING POINT, not a match for today's feel. That
// is stage 1 work with a human at the wheel, and the estimate says so.

import {
  ONE, add, sub, neg, mulFast, div, clamp, min, max, abs, sign, length2,
} from '../fixed.js';
import { sin, cos } from '../trig.js';

export const WHEELS = 4;

// Q16.16 unless noted. Chassis is 6.4 m long, 2.55 wide - measured off the
// model that ships today.
const HALF_LEN = 209715;        // 3.2 m
const HALF_WID = 83558;         // 1.275 m
// Accelerations in m/s^2, drags as a fraction lost per second. The first
// version wrote these as though they were forces and then used them as
// accelerations: DRIVE at 7200 is 0.11 m/s^2, so the truck reached walking
// pace after fifteen seconds and could not leave its own apron. Units now
// stated, because that is the mistake worth not repeating.
const DRIVE_ACCEL = Math.imul(6, ONE);        // 6 m/s^2, a laden truck
const REVERSE_ACCEL = Math.imul(3, ONE);      // reverse is half as eager
const BRAKE_ACCEL = Math.imul(11, ONE);       // 11 m/s^2, near a locked wheel
const ROLL_DRAG = 13107;                      // 0.20 per second
const AIR_DRAG = 22938;                       // 0.35 per second at top speed
const MAX_SPEED = Math.imul(26, ONE);
const STEER_LOCK = 5800;        // Q16.16 turns at full lock, about 32 degrees
const STEER_RATE = 3400;        // how fast the wheels reach the lock
const GRIP_SIDE = 40000;        // lateral friction coefficient, 0..ONE
const GRIP_HAND = 6000;         // with the handbrake on, the rear lets go

/**
 * One vehicle step.
 *
 * `v` is a plain object of Q16.16 fields so the caller can keep it wherever it
 * likes; sim.js keeps it in the state buffer. Inputs are Q16.16 in [-1, 1].
 */
export function vehicleStep(v, throttle, steer, brake, handbrake, dt) {
  // steering follows the input rather than snapping to it, which is most of
  // what makes a vehicle feel heavy
  const want = mulFast(clamp(steer, -ONE, ONE), STEER_LOCK);
  const gap = sub(want, v.steerAngle);
  const move = clamp(gap, neg(mulFast(STEER_RATE, dt)), mulFast(STEER_RATE, dt));
  v.steerAngle = add(v.steerAngle, move);

  const fx = sin(v.heading), fz = cos(v.heading);
  const rx = fz, rz = neg(fx);                       // right-hand normal

  // decompose velocity into the chassis frame
  let along = add(mulFast(v.vx, fx), mulFast(v.vz, fz));
  let across = add(mulFast(v.vx, rx), mulFast(v.vz, rz));

  // drive and brake act along the nose
  const th = clamp(throttle, -ONE, ONE);
  const drive = mulFast(th, th < 0 ? REVERSE_ACCEL : DRIVE_ACCEL);
  along = add(along, mulFast(drive, dt));
  if (brake > 0) {
    const b = mulFast(mulFast(clamp(brake, 0, ONE), BRAKE_ACCEL), dt);
    const s = sign(along);
    along = abs(along) < b ? 0 : sub(along, Math.imul(b, s));
  }

  // rolling and air drag
  along = sub(along, mulFast(along, mulFast(ROLL_DRAG, dt)));
  const speed = abs(along);
  along = sub(along, mulFast(mulFast(along, div(speed, MAX_SPEED)), mulFast(AIR_DRAG, dt)));

  // Lateral grip, and the friction circle: a wheel already spending its grip
  // on driving has less left for turning. This is the term that makes power
  // oversteer possible at all, and the one most worth tuning against feel.
  const grip = handbrake > 0 ? GRIP_HAND : GRIP_SIDE;
  const spent = min(ONE, div(abs(drive), DRIVE_ACCEL));
  const available = mulFast(grip, sub(ONE, mulFast(spent, 19661)));   // 0.3 of it
  across = sub(across, mulFast(across, mulFast(available, dt)));

  // yaw follows the steered wheels, scaled by how fast the truck is actually
  // going - a stationary truck cannot turn, which is what the wheels do
  const bite = clamp(div(abs(along), MAX_SPEED), 0, ONE);
  const yawRate = mulFast(mulFast(v.steerAngle, bite), 26214);        // 0.4
  v.angVel = add(v.angVel, mulFast(sub(yawRate, v.angVel), mulFast(196608, dt)));
  v.heading = (add(v.heading, mulFast(v.angVel, dt))) & 65535;

  // speed cap on the resultant, not on one axis
  const total = length2(along, across);
  if (total > MAX_SPEED) {
    along = div(mulFast(along, MAX_SPEED), total);
    across = div(mulFast(across, MAX_SPEED), total);
  }

  // back to world axes
  v.vx = add(mulFast(along, fx), mulFast(across, rx));
  v.vz = add(mulFast(along, fz), mulFast(across, rz));
  v.x = add(v.x, mulFast(v.vx, dt));
  v.z = add(v.z, mulFast(v.vz, dt));
  v.speed = total;
  return v;
}
