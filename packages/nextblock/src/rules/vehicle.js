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
import { slopeSin } from './ground.js';

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
// These are PORTED FROM TruckController, not derived. The bicycle model that
// was here before was correct and felt nothing like the game: the truck it
// describes has perfect grip, and WheelCollider's does not. Matching the feel
// means matching the thing, so the lock curve, the steering rate and the way
// drive force tapers off with speed are the same laws with the same numbers.
const TOP_SPEED = 2228224;      // 34 m/s, TruckController.topSpeed
// Fitted to the measured PhysX run, not guessed: 0.53 m/s RMS across thirteen
// seconds of full throttle from rest. See tools/measure.js and the fixture in
// test/vectors/physx-reference.json.
const DRIVE_ACCEL = 285082;     // 4.35 m/s^2 at rest, tapering to nothing at TOP
const REVERSE_ACCEL = 142541;   // half as eager
const BRAKE_ACCEL = 720896;     // 11 m/s^2, near a locked wheel
const ROLL_DRAG = 1966;         // 0.03 per second, so it coasts down
const AIR_DRAG = 1966;          // 0.03 per second at top speed
const MAX_SPEED = TOP_SPEED;

// Lerp(34, 9, speed/topSpeed) in TURNS, because that is what heading is in.
const LOCK_SLOW = 6190;         // 34 degrees
const LOCK_FAST = 1638;         // 9 degrees
const STEER_RATE_MUL = 360448;  // 5.5 - the lock is reached in about 0.18 s

// The EFFECTIVE wheelbase, 5.4 m - not the geometric 3.8 m between the axles.
//
// A tyre does not point the truck exactly where it points itself; it slips,
// and the truck turns on a longer arc than the geometry says. Solving the
// bicycle equation backwards from both measured PhysX turns gives 5.39 m and
// 5.39 m - the same number from a 30 m circle and an 11 m one, which is why
// this is a constant and not a curve. Using the real 3.8 m made the core turn
// 41% harder than the game it is replacing.
const WHEELBASE = 353894;

// Lateral grip, as a fraction of sideways speed killed per second.
//
// The old 0.61 was the whole problem. It let the truck crab at FIFTY-FOUR
// degrees of slip - the nose swung round while the body carried on sliding
// almost sideways, which reads as steering that overreacts wildly even though
// the path barely bends. The PhysX truck slips 4 degrees at half lock and 8 at
// full, and this is tuned to land there.
const GRIP_SIDE = 589824;       // 9.0 per second
// Unity's own gravity, resolved along the slope. There is no tuning freedom
// here and none was taken: PhysX puts a rigidbody under Physics.gravity and
// the component along the ground is g*sin(theta). Measured against the PhysX
// truck on the map's own hills it comes back as 9.85 m/s^2.
const GRAVITY = 642908;         // 9.81 m/s^2

// Engine braking, ported from TruckController. Letting go of the throttle on
// a slope HOLDS the truck rather than letting it roll away - a deliberate
// decision in the original, and without it the core simply coasted downhill
// whenever the player stopped driving.
const ENGINE_BRAKE = 9175;      // 0.14 of the brake, above walking pace
const ENGINE_HOLD = 39322;      // 0.60 of it below
const WALKING = 131072;         // 2 m/s

const CORNER_DRAG = 39322;      // 0.6 - forward speed lost per unit of sideways scrub
const GRIP_HAND = 32768;        // 0.5 - with the handbrake on, the rear lets goo

/**
 * One vehicle step.
 *
 * `v` is a plain object of Q16.16 fields so the caller can keep it wherever it
 * likes; sim.js keeps it in the state buffer. Inputs are Q16.16 in [-1, 1].
 */
/**
 * What being hurt costs the driving.
 *
 * `TruckController` held this: `hurt = 1 - condition`, and above 0.02 the
 * throttle is scaled by `Lerp(1, 0.55, hurt)` and the steering takes a pull of
 * `pull * hurt * 0.35` to one side. It ran on `condition`, which `TruckHealth`
 * set from its own pool - a client rule reading a client number, and both are
 * gone.
 *
 * IT WAS ALSO ALREADY DEAD where the core drives. `CoreDrivenTruck` makes the
 * Rigidbody kinematic, and the block that follows this one in
 * `TruckController` takes its speed from `_rb.linearVelocity`, which a
 * kinematic body reports as zero - so the throttle and steer it adjusted were
 * being fed to wheel colliders that resolve nothing. Porting those lines into
 * the client would have been copying a PhysX-era corpse. The rule belongs
 * where the throttle is actually spent, which is here. Nothing here reads a
 * host velocity, and there is no 2-D coupling: the taper touches the throttle
 * and the pull touches the steer, each on its own axis.
 *
 * Measured before it was written: over three seeds the truck is under 98 hit
 * points for 91.4% of the ticks of a full-throttle run and 90.5% of a parked
 * one, mean `hurt` 0.205 and 0.847. This is most of a round, not a corner.
 *
 * The pull direction is `Random.value < 0.5 ? -1 : 1` once at Awake in C#.
 * Here it is derived from the seed rather than drawn, because draw order is
 * protocol and a new draw at init would move every stream after it.
 */
const MAX_HP = Math.imul(100, ONE);
const HURT_FLOOR = 1311;          // 0.02, TruckController's own threshold
const HURT_TAPER = 29491;         // 0.45, so Lerp(1, 0.55, hurt) is 1 - 0.45*hurt
const HURT_PULL = 22938;          // 0.35

export function vehicleStep(v, throttle, steer, brake, handbrake, dt, grade) {
  // Before anything else, as it is in TruckController: the condition block
  // sits above the steering lock and the motor torque, so a hurt truck is
  // steering and accelerating from already-reduced inputs.
  const hurt = sub(ONE, clamp(div(v.hp, MAX_HP), 0, ONE));
  if (hurt > HURT_FLOOR) {
    throttle = mulFast(throttle, sub(ONE, mulFast(HURT_TAPER, hurt)));
    steer = clamp(add(steer, Math.imul(v.pull, mulFast(HURT_PULL, hurt))), -ONE, ONE);
  }

  // steering follows the input rather than snapping to it, which is most of
  // what makes a vehicle feel heavy
  //
  // TruckController's law exactly: the lock tightens with speed, and the
  // wheels reach it at a rate proportional to that lock.
  const frac = clamp(div(abs(v.speed), TOP_SPEED), 0, ONE);
  const lock = add(LOCK_SLOW, mulFast(sub(LOCK_FAST, LOCK_SLOW), frac));
  const want = mulFast(clamp(steer, -ONE, ONE), lock);
  const rate = mulFast(mulFast(STEER_RATE_MUL, lock), dt);
  const gap = sub(want, v.steerAngle);
  v.steerAngle = add(v.steerAngle, clamp(gap, neg(rate), rate));

  const fx = sin(v.heading), fz = cos(v.heading);
  const rx = fz, rz = neg(fx);                       // right-hand normal

  // decompose velocity into the chassis frame
  let along = add(mulFast(v.vx, fx), mulFast(v.vz, fz));
  let across = add(mulFast(v.vx, rx), mulFast(v.vz, rz));

  // drive and brake act along the nose
  //
  // Torque falls away as the truck approaches its top speed, which is what
  // motorTorque * (1 - speed/topSpeed) does in TruckController. Without the
  // taper the core simply ran into a hard speed cap instead of easing up to
  // one, and the last third of the throttle did nothing at all.
  const th = clamp(throttle, -ONE, ONE);
  const taper = sub(ONE, clamp(div(abs(along), TOP_SPEED), 0, ONE));
  const drive = mulFast(mulFast(th, th < 0 ? REVERSE_ACCEL : DRIVE_ACCEL), taper);
  along = add(along, mulFast(drive, dt));

  // Gravity down the slope. Applied to the along-axis only: the core is two
  // dimensional and the truck is always on the ground, so there is nothing for
  // the normal component to do.
  along = sub(along, mulFast(mulFast(GRAVITY, slopeSin(grade | 0)), dt));

  let brakeFrac = clamp(brake, 0, ONE);
  if (th === 0 && handbrake === 0) {
    // Off the throttle is not neutral - a lorry has engine braking, and this
    // is what stops a hill from running away with it.
    const hold = abs(along) < WALKING ? ENGINE_HOLD : ENGINE_BRAKE;
    brakeFrac = max(brakeFrac, hold);
  }
  if (brakeFrac > 0) {
    const b = mulFast(mulFast(brakeFrac, BRAKE_ACCEL), dt);
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
  const kill = min(ONE, mulFast(available, dt));   // never more than all of it
  const scrubbed = mulFast(across, kill);
  across = sub(across, scrubbed);

  // Cornering costs forward speed.
  //
  // A tyre dragged sideways burns the energy somewhere, and in the PhysX truck
  // it comes out of the run down the straight: it holds 18 m/s through a half
  // lock turn but only 10.8 through a full one. Without this the core carried
  // 15 m/s through the same corner and simply outran the thing it is copying.
  const scrub = mulFast(CORNER_DRAG, abs(across));
  const cost = mulFast(scrub, dt);
  along = abs(along) < cost ? 0 : sub(along, Math.imul(cost, sign(along)));

  // Yaw from the bicycle model: omega = v * tan(steer) / wheelbase, and with
  // heading measured in turns the 2*pi cancels, leaving v * steer / wheelbase.
  //
  // What was here before multiplied the steer angle by a DIMENSIONLESS speed
  // fraction and an arbitrary 0.4, so it was not a yaw rate at all - the units
  // did not work out, and the scale that fell out of it gave a turning circle
  // of 117 m on a field 200 m wide. The truck could not go round a corner. The
  // small-angle approximation for tan is worth 11% at full lock and nothing at
  // all at the angles actually reachable at speed.
  const yawRate = div(mulFast(along, v.steerAngle), WHEELBASE);
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
