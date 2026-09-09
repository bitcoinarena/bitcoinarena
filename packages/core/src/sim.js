// One tick of the world.
//
// The rules live in src/rules/*; this file is only the order they run in - and
// that order IS PROTOCOL. Vehicle, then army, then score, then outcome. A rule
// inserted between two of them changes every hash ever produced, so new work
// goes at the end of a phase, never in the middle.
//
// The same applies to random draws: each unit draws its wobble, and only then,
// and only if in range, its reload and hit roll. That sequence is the reason a
// transcript recorded today can still be replayed next year.

import { TICK_DT } from './tick.js';
import { ONE, HALF, add, sub, mulFast, div, idiv, clamp, min, max, abs, length2, cbrt } from './fixed.js';
import { seed, spawnBay, SOLO_BAY, BAY_COUNT } from './rng.js';
import { sin, cos } from './trig.js';
import {
  create, unitBase, heliBase, bombBase, MAX_UNITS, O_UNITS, U_WORDS, UNITS, ARMOUR_MASK,
  O_TICK, O_RNG, O_TRUCK, O_SCORE, O_ARMY,
  A_ARMOUR_BULL, A_ARMOUR_BEAR, A_RIFLE_BULL, A_RIFLE_BEAR,
  O_AIR, AIR_BULL, AIR_BEAR, MAX_HELIS, MAX_BOMBS,
  O_LIQ, L_PENDING, L_LAST, L_SERIAL, LIQ_MAX,
  O_STRIKE, K_STATE, K_X, K_Z, K_LOAD, K_SERIAL,
  O_CRATERS, MAX_CRATERS, craterBase, C_X, C_Z, C_R, C_D, C_ROUNDS,
  H_STATE, H_SIDE, H_X, H_Y, H_Z, H_DIR, H_T, H_DROPIN,
  B_STATE, B_SIDE, B_X, B_Y, B_Z, B_VX, B_VY, B_VZ,
  T_X, T_Z, T_HEADING, T_VX, T_VZ, T_ANGVEL, T_HP, T_CARGO, T_FLAGS,
  T_WHEEL, T_THROTTLE, T_STEER, T_IMPACT,
  S_EXPOSURE, S_ELAPSED, S_BESTX, S_CARGO, S_DELIVERED, S_STATE, S_PRACTICE, S_HEAT,
  U_X, U_Z, U_SIDE, U_HP, U_HEADING, U_STATE, U_COOLDOWN, U_TARGET,
  O_SQUADS, SQUADS_PER_SIDE, SQUAD_WORDS,
} from './state.js';
// Named imports, not namespaces. `import * as x` cannot survive concatenation
// into a single browser file - after the import line is stripped, every
// `x.thing` points at nothing - and a real bundler in the trust path is
// exactly what section 3.6 argues against for anything that pins money.
import { vehicleStep } from './rules/vehicle.js';
import { flatGround, groundFromSeed, gradeAlong, heightAtWorld, DEFAULT_COLS, DEFAULT_ROWS } from './rules/ground.js';
import { noSolids, resolveSolids, resolveArmour, BOX_WORDS } from './rules/solids.js';
import { stepUnit, separatePair, clearOfTruck, runOver, truckSpeed, threatAt, pickTarget, pickRifleTarget, riflePost, RELOAD_MIN, RELOAD_SPAN, DAMAGE_MIN, DAMAGE_SPAN, BACKOFF_RANGE, HIT_PER_MIL, ARMOUR_RANGE, RIFLE_RANGE, RIFLE_HIT_PER_MIL, RIFLE_RELOAD_TICKS, RIFLE_RELOAD_TICKS_SPAN, RIFLE_LOOK_TICKS, RIFLE_LOOK_TICKS_SPAN, RIFLE_HP, RIFLE_DAMAGE, COURIER_RANGE, COURIER_DAMAGE_MIN, COURIER_DAMAGE_SPAN, COURIER_RIFLE_MIN, COURIER_RIFLE_SPAN, courierReach, outranksTheFoe, shellForHeat } from './rules/army.js';
import { accrue, earning, scoreOf, frontWeight } from './rules/score.js';
import { outcome, RUN_LIVE, RUN_DELIVERED, RUN_WRECKED, RUN_MISSED } from './rules/gate.js';
import { frontlineZ, SAMPLES } from './rules/frontline.js';
import {
  launchHeli, stepHeli, releaseBomb, stepBomb, bombDamage, blastReach, sortieWait, fallTime, NO_AIM, BOMB_RADIUS,
  AIR_RELEASE, AIR_GONE,
} from './rules/air.js';

// UNITS and ARMOUR_MASK live in state.js so the generated C# mirror carries
// them; re-exported here because every tool and rule already reads them from
// this module.
export { UNITS, ARMOUR_MASK };
/**
 * The van is soft but not paper.
 *
 * `TruckHealth.Damage` is `Health -= amount / armour` with `armour = 1.5`, and
 * the amount it is handed is the raw shell: `CourierHit?.Invoke(Rand(5f, 11f))`
 * carries what the gun did, and that method's own summary says "Amount is
 * before armour". So the divisor is a deliberate, dimensionless toughness knob
 * on the game side - the tooltip says so in as many words - and not a units
 * confusion or the leftover of a formula.
 *
 * The core had the raw amount and the same maxHealth of 100 and did not
 * divide, which made its truck half again as soft as the one the game shipped.
 * Measured on ONE hit sequence, parked at (0, 0) with the air off, three
 * seeds: 100 points was reached at 24.9 / 14.5 / 16.1 s, and 150 - the same
 * hits against a truck that divides them - at 33.5 / 21.0 / 23.7 s.
 *
 * A divisor on the HIT rather than a bigger pool, because that is the shape
 * the rule has: C# applies `/armour` to every `Damage()` call it makes,
 * including the crash path, so a truck that is tougher against shells is
 * tougher against everything by the same factor.
 */
export const TRUCK_ARMOUR = Math.imul(3, ONE) >> 1;   // 1.5, TruckHealth.armour

/**
 * What a crash costs, which until now was nothing at all.
 *
 * The core noticed the impact and priced it nowhere: `T_IMPACT` was written
 * for the host to read and `T_HP` was reduced by courier fire and by nothing
 * else. `TruckHealth` held the rule - `rammed >= crashSpeed` writes the truck
 * off, otherwise `Damage(rammed * 6f)` - and that was client-side simulation
 * of an outcome, which is what M1 removes.
 *
 * The quantity is a SPEED and it always was: `TakeImpact` is `T_IMPACT / ONE`
 * and the word is set in `resolveArmour` from the component of the truck's
 * velocity along the contact normal. No distance was read as a speed here, so
 * there is no units fault to avoid copying - the six is points per metre per
 * second, and it is a rate, not a leftover.
 *
 * The six is applied BEFORE the armour divisor, because C# applied it inside
 * `Damage`, which divided. So a shunt at 3 m/s costs 3 * 6 / 1.5 = 12 points,
 * exactly as it did in the game.
 *
 * The burnt-out-hull branch - `impact * 3f`, and never a write-off - has no
 * counterpart yet, because the core has no hulls. It is on the list with
 * `Army.Wrecks`.
 */
const CRASH_WRITE_OFF = Math.imul(4, ONE);       // TruckHealth.crashSpeed
const CRASH_FLOOR = ONE >> 1;                    // 0.5 m/s, below it nothing
const CRASH_POINTS = Math.imul(6, ONE);          // points per m/s

export const HALF_X = Math.imul(130, ONE);
export const HALF_Z = Math.imul(85, ONE);
// The tick itself lives in `tick.js`, which is what the protocol reads: one
// definition of how long a tick is, not one here and another there.
export { TICK_DT } from './tick.js';
// The loading bay, and it has to be the SAME bay Unity draws.
//
// This was -114, which is postX - the facade line itself. The truck spawned
// fourteen metres too far back, buried in the loading dock, clipping through
// it with the chase camera jammed against a white slab a couple of metres from
// the lens. That is what "the bay is completely white at launch" was: not a
// lighting fault at all, but a camera with its nose against a wall.
//
// The z was wrong too, and by more: -78.2 is bay 1, the far END of a 168 m
// frontage, while the game parks a solo player in bay 14 - the middle one, the
// one the road actually leaves from. So the truck started eighty-eight metres
// along the building from its own lane AND fourteen metres inside the wall.
//
// PostOffice.BayFor(SoloBay) is the authority; TruckSpawnTests holds the two
// numbers together so they cannot drift apart again in silence.
export const START_X = -6579814;                   // -100.4 m, 14 m out on the apron
export const START_Z = 668467;                     // 10.2 m, the solo bay (14 of 24)
export { spawnBay, SOLO_BAY, BAY_COUNT };
// 6.8 m door pitch, Q16.16. Bay 13 stays START_Z; other doors step from there.
export const BAY_PITCH = 445645;
export function bayZ(bay) {
  let i = bay | 0;
  if (i < 0) i = 0;
  if (i > 23) i = 23;
  return (START_Z + Math.imul(i - SOLO_BAY, BAY_PITCH)) | 0;
}
// Every fourth unit is armour. A mask rather than a modulo: '%' is banned
// outside the arithmetic files, and a power of two makes the ban free.


/** Every fourth unit is a tank. Shared, so the collision and the fighting agree. */
const isArmour = (i) => (i & ARMOUR_MASK) === 0;

/** A price tape, so the frontline has something to follow. */
function tape(rngWords) {
  const h = new Int32Array(SAMPLES);
  let p = Math.imul(78000, ONE >> 8);
  for (let i = 0; i < SAMPLES; i++) {
    const step = ((Math.imul(i + 1, 2654435761) >>> 20) - 2048) | 0;
    p = add(p, Math.imul(step, 64));
    h[i] = p;
  }
  return h;
}

/**
 * Hands the core the relief the host is drawing.
 *
 * Round setup, not per-tick input: it is uploaded once, before anyone moves,
 * and never touched again. That is what lets it stay outside the hashed state
 * without weakening anything - in the protocol it belongs with the fee profile
 * it came from, agreed and committed at the start of the round.
 *
 * `heights` is row-major, Q16.16 metres, cols*rows long.
 */
/**
 * A HEIGHT FIELD FROM OUTSIDE, AND NO PLAYER MAY REACH THIS ANY MORE.
 *
 * This was the host's door: Unity uploaded the relief it was drawing and the
 * core felt it. Letter 36 took it away - `init` generates the relief from the
 * round's seed, and a page that could overwrite it would put the player back
 * in a world nobody else can replay. `BlwpSetGround` is gone from the jslib
 * and `SetGround` from `BlwpCore`, so nothing in a browser can call this.
 *
 * It stays for the one caller that is not a host: the reference tests, which
 * reproduce a published dataset and need the exact field it was measured on.
 * A ground put here is marked as such, because a restart must keep an uploaded
 * one and must NOT keep a generated one - the seed makes that again.
 */
export function setGround(st, cols, rows, heights) {
  if (cols < 2 || rows < 2 || heights.length < Math.imul(cols, rows)) return false;
  const g = flatGround(cols, rows);
  g.h.set(heights.subarray(0, Math.imul(cols, rows)));
  st.ground = g;
  st.uploadedGround = true;
  return true;
}



/**
 * Puts the truck back, stationary and pointing down the map.
 *
 * A host command, not a rule: the round ended, or the truck was written off,
 * and it belongs back in the bay. It has to go through the core because the
 * core owns the position - TruckController.Respawn set the Transform and the
 * Rigidbody, and the core overwrote both on the very next frame, so a missed
 * block left the player standing at the miner loading fresh freight where they
 * were.
 *
 * Everything that carries momentum is cleared with it. Leaving the velocity
 * behind teleports a truck doing 20 m/s into the bay still doing 20 m/s.
 */
export function teleport(st, x, z, heading) {
  const s = st.i32, T = O_TRUCK;
  s[T + T_X] = x | 0;
  s[T + T_Z] = z | 0;
  s[T + T_HEADING] = (heading | 0) & 65535;
  s[T + T_VX] = 0; s[T + T_VZ] = 0;
  s[T + T_ANGVEL] = 0; s[T + T_STEER] = 0; s[T + T_WHEEL] = 0;
  return true;
}

/** Surface height under a world position, for whatever is drawing the truck. */
/**
 * Hands the core the solid world, as axis-aligned boxes in XZ.
 *
 * `boxes` is cx, cz, hx, hz, yLow, yHigh per obstacle, Q16.16 metres. Round
 * setup, like the relief: uploaded once and never touched while the round
 * runs, so it can stay outside the hashed state and still be something every
 * player has agreed on.
 */
export function setSolids(st, count, boxes) {
  const n = Math.imul(count, BOX_WORDS);
  if (count < 0 || boxes.length < n) return false;
  const box = new Int32Array(n);
  box.set(boxes.subarray(0, n));
  st.solids = { n: count, box };
  return true;
}

/**
 * Starts a new round without throwing away the world the host uploaded.
 *
 * `outcome` latches: once a run leaves RUN_LIVE nothing brings it back, and
 * only `init` sets it live again. `BlwpCore.Init` runs once, in Start, and
 * `teleport` - the host command all three round endings go through, delivery,
 * write-off and missed block - moves the truck and clears its momentum and
 * touches neither `S_STATE` nor `T_HP`. So every round after the first was the
 * first round's leftovers. Measured in a browser, run 2 against a fresh
 * `init`: twelve of thirty words carried over, `S_STATE` 0 -> 1 at the head of
 * them, and that one alone withholds damage, exposure, delivery and score,
 * because each is gated on RUN_LIVE. The second round was unplayable and
 * looked fine.
 *
 * The reset belongs here and not in the host. A C# that wipes `S_STATE` and
 * `T_HP` is simulating again, and would have to know every word a round
 * touches - the replacement clocks, the sortie clocks, the tape, the dead
 * units - which is the list that grows silently. `init` already knows it.
 *
 * What is NOT part of a round is the world the host uploaded: the relief and
 * the solids are setup, agreed before the first tick and unchanged by playing.
 * Carrying them over is not leniency, it is the difference between a restart
 * and a truck driving over a flat table for however many frames it takes Unity
 * to notice and re-send a terrain.
 */
/**
 * Queues a liquidation for the next tick. Size in MILLIONS of USD, Q16.16.
 *
 * This is the whole of the client's part: a live Binance `!forceOrder@arr`
 * message and the simulation clock are two callers of this one function, so
 * the same size gives the same strike, the same crater and the same
 * irradiation whichever of them sent it. Nothing is decided here.
 *
 * Two in one frame keep the LARGER, because the size is the crater and the
 * bigger one is the crater you would see; `L_SERIAL` still counts both, so a
 * replay that dropped one cannot match the digest. Sizes at or below zero are
 * refused rather than clamped to nothing: a caller passing a bad number
 * should learn it from the return value, not from a silent no-op that a
 * replay would then have to reproduce.
 *
 * Returns true if it was queued.
 */
/**
 * Where a liquidation strike lands: the densest knot of living units within
 * 40 m of the front at their own x.
 *
 * A place that matters, not a clock and not a die. It is deliberately NOT the
 * gunship's `aimPoint`: that one searches around where a falling bomb is
 * already going, because the aircraft's `vx` has already decided the landing
 * x. A strike has no aircraft and no inherited speed, so the whole field is
 * open to it and the only question is where the fighting is.
 *
 * Both sides count. A liquidation is not a side's weapon - it is the market
 * hitting the battlefield - so the knot it picks is the knot that is there,
 * whoever is standing in it.
 *
 * Index order, densest first, ties to the lower index. With nobody alive
 * anywhere near the line it falls on the front at x = 0, which is a place and
 * not a random draw.
 */
/**
 * The crater a load digs. Radius in metres Q16.16, depth with it.
 *
 * A crater follows the CUBE ROOT of the energy, which is also what makes the
 * rule usable here: liquidations run over three decades, from a million to a
 * billion, and a cube root turns that into a factor of ten instead of the
 * 31.6 a square root would give. Both ends are quantities this core already
 * names rather than numbers picked to taste - `BOMB_RADIUS`, 16 m, at one
 * million, and the 40 m front band at a thousand.
 *
 * DEPTH IS 0.225 OF THE RADIUS, AND THAT NUMBER IS MEASURED, NOT CHOSEN. The
 * geologist's ratio for a simple crater is a fifth of the diameter - 0.4 of
 * the radius - and at 0.4 the truck is trapped: driven from the centre at
 * full throttle it never leaves a 100 M crater or a 1000 M one in forty
 * seconds, and takes 36.2 s to crawl out of the smallest.
 *
 * The wall's steepest gradient is exactly 2 * D/R. Driven up a constant slope
 * the truck holds 0.45 - 2.03 m/s uphill - and at 0.50 it slides backwards.
 * So D/R must be under 0.225, and this sits ON that limit rather than half of
 * it. A hole a player cannot see is not a crater, and 0.15 was the cautious
 * end of the same rule rather than a second measurement.
 *
 * The whole ladder was driven again, from the crater floor at full throttle,
 * to find where the wall actually beats the truck rather than where the
 * arithmetic says it should:
 *
 *   D/R 0.150   1000 M floor  -6.00 m   out after  5.3 s
 *   D/R 0.180   1000 M floor  -7.20 m   out after  5.4 s
 *   D/R 0.200   1000 M floor  -8.00 m   out after  5.5 s
 *   D/R 0.225   1000 M floor  -9.00 m   out after  5.7 s
 *   D/R 0.250   1000 M floor -10.00 m   out after 10.8 s
 *   D/R 0.300   1000 M floor -12.00 m   NEVER out in 40 s
 *
 * So the cliff is between 0.25 and 0.30, and 0.225 costs 0.4 s over 0.15.
 * Doubling was asked for and is not available: at 0.30 the truck cannot leave
 * the largest crater at all. A crater is ground to be driven, not a hole to
 * be caught in.
 *
 * Lifetime rides the same root, so one rule sets both: ten rounds at the
 * small end, twenty at the large, which is the span (z) asks for.
 */
const CRATER_R_MIN = Math.imul(16, ONE);
const CRATER_R_MAX = Math.imul(40, ONE);
const CRATER_LOAD_MIN = ONE;                       // one million
const CRATER_LOAD_MAX = Math.imul(1000, ONE);      // a thousand million

function craterOf(load) {
  const lo = cbrt(CRATER_LOAD_MIN), hi = cbrt(CRATER_LOAD_MAX);
  const t = clamp(div(sub(cbrt(clamp(load, CRATER_LOAD_MIN, CRATER_LOAD_MAX)), lo),
                      sub(hi, lo)), 0, ONE);
  const r = add(CRATER_R_MIN, mulFast(t, sub(CRATER_R_MAX, CRATER_R_MIN)));
  return { r, d: mulFast(r, 14746), rounds: add(Math.imul(10, ONE), mulFast(t, Math.imul(10, ONE))) >> 16 };
}

/**
 * How hard the fallout bites at the centre of a crater, in health a second.
 *
 * BOTH ENDS ARE MEASURED, not chosen. Driven across the diameter at full
 * throttle the truck spends 4.1, 4.8 and 6.3 seconds inside the radius of a
 * 10, 100 and 1000 million crater, and the bowl profile it drives through
 * integrates to 2.25, 2.66 and 3.51 second-equivalents. Against those two
 * measurements the rule is anchored on quantities the core already carries:
 *
 *   the small end   one crossing costs about one shell. A courier hit is
 *                   `Rand(5, 11)`, and the crossing of a 1 M crater is
 *                   MEASURED at 9.9 health - inside that band. The first
 *                   attempt used 4 a second on an integral guessed from the
 *                   10 M crossing and cost 14.0, outside it; the constant
 *                   follows the measurement rather than the estimate.
 *   the large end   one crossing at full health is lethal. The truck has
 *                   100, and the crossing of a 1000 M crater is measured at
 *                   exactly that.
 *
 * Between them it rides the SAME normalised load the radius, the depth and
 * the lifetime ride, recovered from the stored radius so it costs no state
 * word. One rule, four consequences.
 *
 * The falloff is the bowl's own, `1 - (r/R)^2`: the fallout lies where the
 * ground was thrown out of, so the deepest place is the worst place, and
 * there is one shape in this letter rather than two.
 *
 * NOT divided by `TRUCK_ARMOUR`, and that is deliberate rather than
 * forgotten. Every other hit on the truck is, because 1.5 is plating against
 * a shell and a blast. The contract's word here is IRRADIATED, and plating is
 * not what stops that; routing it through the divisor would also make the two
 * anchors above mean something other than what they say.
 */
const FALLOUT_MIN = Math.imul(2, ONE);
const FALLOUT_MAX = Math.imul(28, ONE);

function falloutRate(R) {
  const t = clamp(div(sub(R, CRATER_R_MIN), sub(CRATER_R_MAX, CRATER_R_MIN)), 0, ONE);
  return add(FALLOUT_MIN, mulFast(t, sub(FALLOUT_MAX, FALLOUT_MIN)));
}

/** The crater slot to use: a free one, else the one with fewest rounds left. */
function craterSlot(s) {
  let worst = -1, least = 0x7fffffff;
  for (let i = 0; i < MAX_CRATERS; i++) {
    const b = craterBase(i);
    if (s[b + C_ROUNDS] <= 0) return i;
    if (s[b + C_ROUNDS] < least) { least = s[b + C_ROUNDS]; worst = i; }
  }
  return worst;
}

function strikePoint(s, seamAt) {
  let bestI = -1, bestN = 0;
  for (let i = 0; i < UNITS; i++) {
    const b = unitBase(i);
    if (s[b + U_STATE] === 0 || s[b + U_HP] <= 0) continue;
    if (abs(sub(s[b + U_Z], seamAt(s[b + U_X]))) > Math.imul(40, ONE)) continue;
    let n = 0;
    for (let j = 0; j < UNITS; j++) {
      const c = unitBase(j);
      if (s[c + U_STATE] === 0 || s[c + U_HP] <= 0) continue;
      if (abs(sub(s[c + U_X], s[b + U_X])) > BOMB_RADIUS) continue;
      if (abs(sub(s[c + U_Z], s[b + U_Z])) > BOMB_RADIUS) continue;
      n = (n + 1) | 0;
    }
    if (n > bestN) { bestN = n; bestI = i; }
  }
  if (bestI < 0) return { x: 0, z: seamAt(0) };
  const b = unitBase(bestI);
  return { x: s[b + U_X], z: s[b + U_Z] };
}

export function submitLiquidation(st, size) {
  const v = size | 0;
  if (v <= 0) return false;
  const s = st.i32;
  const capped = v > LIQ_MAX ? LIQ_MAX : v;
  if (capped > s[O_LIQ + L_PENDING]) s[O_LIQ + L_PENDING] = capped;
  s[O_LIQ + L_SERIAL] = (s[O_LIQ + L_SERIAL] + 1) | 0;
  return true;
}

export function restart(st, seedWord) {
  const fresh = init(seedWord);
  // NOT THE OLD GROUND. `init` makes the relief the seed names, and a restart
  // into the same seed makes the same relief; carrying the previous one over
  // would keep a host-uploaded field alive across a round and put the two
  // sides back in different worlds.
  if (st.uploadedGround) fresh.ground = st.ground;
  fresh.solids = st.solids;
  // The craters cross the round with the ground, one round older. This is why
  // the lifetime is counted in ROUNDS and lives here: a round is a thing that
  // ends, and a tick is not.
  for (let i = 0; i < MAX_CRATERS; i++) {
    const b = craterBase(i);
    const left = (st.i32[b + C_ROUNDS] - 1) | 0;
    if (left <= 0) continue;
    fresh.i32[b + C_X] = st.i32[b + C_X];
    fresh.i32[b + C_Z] = st.i32[b + C_Z];
    fresh.i32[b + C_R] = st.i32[b + C_R];
    fresh.i32[b + C_D] = st.i32[b + C_D];
    fresh.i32[b + C_ROUNDS] = left;
  }
  return fresh;
}

/**
 * How deep the craters cut at a point, in metres Q16.16.
 *
 * A bowl, `d(r) = D * (1 - (r/R)^2)`: two multiplies, no trig, zero at the
 * rim so there is no step for a wheel to catch on. No raised lip - that would
 * be a second term and it is not in this step.
 *
 * They ADD where they overlap, which is what two explosions in one place do,
 * and the whole thing is bounded by the eight slots.
 */
function craterCut(s, x, z) {
  let cut = 0;
  for (let i = 0; i < MAX_CRATERS; i++) {
    const b = craterBase(i);
    const R = s[b + C_R];
    if (R <= 0 || s[b + C_ROUNDS] <= 0) continue;
    const dx = sub(x, s[b + C_X]), dz = sub(z, s[b + C_Z]);
    if (abs(dx) > R || abs(dz) > R) continue;
    const r = length2(dx, dz);
    if (r >= R) continue;
    const t = div(r, R);                       // 0 at the centre, ONE at the rim
    cut = add(cut, mulFast(s[b + C_D], sub(ONE, mulFast(t, t))));
  }
  return cut;
}

/**
 * THE SURFACE, and the only place that answers what it is.
 *
 * The relief the host uploaded, less whatever the craters have taken out of
 * it. Three readers used to sample `st.ground` on their own - the slope under
 * the truck, the resolution against solids, and the air's `groundAt` - and
 * three readers of one quantity is how two of them end up disagreeing. They
 * all come through here now.
 */
export function surfaceAt(st, x, z) {
  return sub(heightAtWorld(st.ground, x, z, HALF_X, HALF_Z),
             craterCut(st.i32, x, z));
}

export function groundAt(st, x, z) {
  return surfaceAt(st, x, z);
}

export function init(seedWord) {
  const st = create();
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  seed(rng, seedWord);

  s[O_TRUCK + T_X] = START_X;
  s[O_TRUCK + T_Z] = bayZ(spawnBay(seedWord));
  s[O_TRUCK + T_HEADING] = 16384;           // facing +x, down the map
  s[O_TRUCK + T_HP] = Math.imul(100, ONE);
  // Which way a hurt truck pulls. Derived from the seed rather than drawn,
  // because a draw here would shift every stream after it and draw order is
  // protocol; C# takes it from `Random.value` once at Awake.
  s[O_TRUCK + T_FLAGS] = (Math.imul(seedWord | 0, 2654435761) >>> 31) & 1;
  s[O_TRUCK + T_CARGO] = 45875;             // 0.7 of a bed
  s[O_SCORE + S_BESTX] = START_X;
  s[O_SCORE + S_CARGO] = 45875;
  s[O_SCORE + S_STATE] = RUN_LIVE;

  st.tape = tape(rng);

  // THE RELIEF IS THE ROUND'S, AND IT IS MADE HERE.
  //
  // It was flat until a host uploaded one, and the host was the only party that
  // ever did: the page uploaded `MempoolTerrain.HeightGrid` into its own core
  // and every committee replayed the same drive on a table. 0.000 m apart on
  // the level apron, 33.500 m apart six hundred ticks later - so a run that
  // left flat ground was judged in a world nobody drove, and the picture every
  // other player was shown was that flat run.
  //
  // Generated from the seed, so the player and every node that replays them
  // arrive at the same hills by construction rather than by agreement. Unity
  // draws what this says now; it does not say what this should be.
  st.ground = groundFromSeed(seedWord, DEFAULT_COLS, DEFAULT_ROWS, HALF_X, HALF_Z);

  // An empty world until the host says otherwise. Empty is honest: a core
  // inventing walls the player cannot see is worse than one with none.
  st.solids = noSolids();

  // The tanks the player can see are the host's, and it sends them every
  // tick. Empty until it does.
  // Sized once for every armour slot there can be. Filled from the core's own
  // units at the top of each step; see `fillArmour`.
  st.armour = { n: 0, xz: new Int32Array(Math.imul(UNITS >> 2, 2)) };

  // The squad anchors first, because a rifleman is put ON his post when he
  // spawns and cannot be if the post does not exist yet. C# reaches the same
  // order the other way round - EnsureSquads runs inside the first infantry
  // Spawn of a side - and the count is its own arithmetic: three a side, from
  // `want = max(3, strength / 12)` at 36 riflemen.
  //
  // Drawn per side and independent of the other side's, which is the whole
  // point: shared columns are what let one bomb kill men of both armies.
  for (let k = 0; k < SQUAD_WORDS; k++)
    s[O_SQUADS + k] = Math.imul(nextBelow(rng, 161) - 80, ONE);

  for (let i = 0; i < UNITS; i++) spawnUnit(s, rng, i);
  return st;
}

/** Word holding squad `k` of `side`. Bull's three, then Bear's. */
const squadWord = (side, k) => O_SQUADS + (side < 0 ? k : SQUADS_PER_SIDE + k);

/**
 * The squads walk, and the two sides' walk apart.
 *
 * `Army.DriftSquads`: every anchor moves by sin(Time * 0.12 + i * 2.4) * 3.6
 * a second and is held inside the field. Angles here are Q16.16 TURNS, so a
 * radian is 65536 / 2pi = 10430.22 units: 0.12 rad/s is 1252 units a second,
 * and the 2.4 rad between squads is 25032.
 *
 * Draws nothing. It runs between the unit loop and the air because that is
 * where Army.Update runs it, and the order is protocol even for a step that
 * touches no random number - it decides where the men are standing when the
 * bombs go off.
 */
function driftSquads(s) {
  const angle = idiv(Math.imul(s[O_TICK], 1252), 60);
  for (let k = 0; k < SQUADS_PER_SIDE; k++) {
    const phase = (angle + Math.imul(k, 25032)) & 65535;
    const step = mulFast(sin(phase), 3932);        // 3.6 m/s * (1/60) s
    for (const side of [-1, 1]) {
      const w = squadWord(side, k);
      s[w] = clamp(add(s[w], step), Math.imul(-80, ONE), Math.imul(80, ONE));
    }
  }
}

/**
 * The side a slot belongs to. Bit two, so that armour - every fourth index -
 * alternates as well.
 *
 * Populate() in the C# army gives each side exactly the same armour and the
 * same infantry. Flipping a coin per unit produced sixteen tanks against
 * eight, and in a lethal exchange an advantage compounds - the larger side
 * lost nobody while the smaller was wiped out. Both armies must start equal or
 * there is no front to hold, only a countdown. Deriving the side from the
 * index rather than drawing it also means a replacement always refills the
 * side and the arm that lost the unit.
 */
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);

/**
 * Put a unit on the field in slot `i`, at its own army's edge.
 *
 * One function for the two callers that need it - Populate at the start of a
 * round and Reinforce during it - because C# has one Spawn() and two armies
 * that spawn differently is a difference nobody would see until a replacement
 * walked on somewhere a starter never could.
 *
 * Draw order: x, z, hp, heading, reload, cooldown, and for a rifleman a squad
 * after them. It is part of the protocol: a verifier drawing them in another
 * order gets another army.
 *
 * The x draw happens for a rifleman too and is then thrown away, because C#
 * does exactly that - `float x = Rand(...)` at the top of Spawn and
 * `unit.x = clamp(squads[squad] + squadOffsetX)` at the bottom of the
 * infantry branch.
 */
function spawnUnit(s, rng, i) {
  const b = unitBase(i);
  // The battlefield, and only the battlefield.
  //
  // This was the full width of the map, so a tank could be placed at x=-100
  // - which is where the truck is parked. With the armour made solid the
  // truck was then shoved off its own apron before the player touched
  // anything. Unity holds its units to |x| < 88 for the same reason; these
  // are the same bounds.
  //
  // And each side comes in at its OWN edge and walks up, rather than
  // appearing at a random depth in the middle of the fighting. C# Spawn does
  // the same, and its comment says why: replacements arrive DURING the round,
  // so a unit that appeared thirty metres from the fighting appeared in plain
  // view.
  const side = sideOf(i);
  s[b + U_X] = Math.imul(nextBelow(rng, 176) - 88, ONE);
  s[b + U_Z] = Math.imul(Math.imul(side, 79) - Math.imul(side, nextBelow(rng, 4)), ONE);
  s[b + U_SIDE] = side;
  // A tank has 6 to 10 hit points in the C# and a rifleman has exactly 1, and
  // the ternary that says so draws NOTHING for a rifleman:
  //
  //     hp = vehicle ? Rand(6f, 10f) : 1f
  //
  // Ported with the draw as well as the value. Before this every unit in the
  // core spawned with a tank's hit points, so a rifle round taking one man's
  // worth of damage would have needed six to ten hits to kill him.
  s[b + U_HP] = isArmour(i) ? Math.imul(60 + nextBelow(rng, 40), ONE) : RIFLE_HP;
  s[b + U_HEADING] = nextBelow(rng, 65536);
  s[b + U_STATE] = 1;

  // Staggered reload, as the C# army staggers it at spawn.
  //
  // Left at zero, every tank fires on the first tick, in index order, and
  // the side holding the lower indices wins every exchange before the other
  // has fired at all: one army went from eleven to two while the other lost
  // nobody. A front is made of two sides shooting on their own clocks.
  s[b + U_TARGET] = nextBelow(rng, 180);
  s[b + U_COOLDOWN] = nextBelow(rng, 120);
  // The stagger used to be thrown away on the next line - `U_TARGET = -1` - so
  // every tank could fire on its first tick of contact. The word is shared: it
  // is the armour's reload counter and the rifleman's squad, and the -1 was
  // there to clear it before the infantry branch below writes the squad into
  // it. That branch overwrites it anyway, so the clear only ever cost the
  // armour its stagger. Measured before it went: U_TARGET was -1 on every tank
  // of every seed, one distinct value, against Army.cs:262's Rand(0f, 3f).

  // A rifleman picks a squad - `unit.squad = _rng.Next(squads.Count)` - and is
  // put straight on its post rather than walking in from wherever the x draw
  // put him. U_TARGET is the armour's reload counter and a rifleman has no use
  // for it, so his squad lives there.
  if (!isArmour(i)) {
    const k = nextBelow(rng, SQUADS_PER_SIDE);
    s[b + U_TARGET] = k;
    s[b + U_X] = clamp(riflePost(s[squadWord(side, k)], i),
                       Math.imul(-88, ONE), Math.imul(88, ONE));
  }
}

/**
 * How many of each arm a side keeps in the field, and how long it waits for a
 * replacement. Both follow from the slot scheme: armour is every fourth index,
 * the side is bit two, so of ninety-six slots each side holds twelve tanks and
 * thirty-six riflemen.
 */
const ARMOUR_PER_SIDE = UNITS >> 3;
const RIFLE_PER_SIDE = Math.imul(3, UNITS >> 3);
const REINFORCE_ARMOUR = Math.imul(6, ONE);        // Army.ReinforceSeconds
const REINFORCE_RIFLE = Math.imul(5, HALF);        // Army.InfantryReinforceSeconds, 2.5 s

/**
 * The four replacement clocks, in the order they are served. Armour for both
 * sides, then infantry for both, which is the order C# Reinforce runs them in
 * - and the order is protocol, because each spawn draws from the same stream.
 */
const CLOCKS = [
  { word: A_ARMOUR_BULL, side: -1, armour: true, want: ARMOUR_PER_SIDE, wait: REINFORCE_ARMOUR },
  { word: A_ARMOUR_BEAR, side: 1, armour: true, want: ARMOUR_PER_SIDE, wait: REINFORCE_ARMOUR },
  { word: A_RIFLE_BULL, side: -1, armour: false, want: RIFLE_PER_SIDE, wait: REINFORCE_RIFLE },
  { word: A_RIFLE_BEAR, side: 1, armour: false, want: RIFLE_PER_SIDE, wait: REINFORCE_RIFLE },
];

/**
 * Replace the dead, the way Army.Reinforce does.
 *
 * The cadence is not flat, and that is the whole design: `timer -= dt *
 * deficit` brings the next replacement faster the further behind a side is.
 * C#'s comment on that line says it was added because a fixed one-per-six-
 * seconds cannot recover from a collapse - measured, one side sat at 0-1 tanks
 * for five minutes while the other held eleven. The core reproduced that
 * failure exactly before this existed: one army wiped inside thirty seconds,
 * the survivors then standing still with nothing inside the 46 m gun for the
 * remaining minute. Replacement is not a garnish on the army; it is what holds
 * the front up.
 *
 * Not conditional on anything the player does, practice included. practice.json
 * states that practice "changes nothing else - the army still fires and still
 * counts towards danger, so the draw order is identical", and a replacement
 * that only arrived in a scored run would break that promise silently.
 */
function reinforce(s, rng) {
  for (const c of CLOCKS) {
    // Alive, and the first free slot of that side and arm. One pass for both:
    // the slot's index already fixes which army and which arm it refills.
    let alive = 0, slot = -1;
    for (let i = 0; i < UNITS; i++) {
      if (isArmour(i) !== c.armour || sideOf(i) !== c.side) continue;
      if (s[unitBase(i) + U_STATE] !== 0) alive = (alive + 1) | 0;
      else if (slot < 0) slot = i;
    }

    const deficit = (c.want - alive) | 0;
    if (deficit <= 0) continue;

    // The clock only runs while a side is short, as C#'s does - it is not a
    // spawn rate, it is a queue that starts when someone dies.
    s[O_ARMY + c.word] = sub(s[O_ARMY + c.word], Math.imul(deficit, TICK_DT));
    if (s[O_ARMY + c.word] > 0) continue;
    s[O_ARMY + c.word] = c.wait;
    if (slot >= 0) spawnUnit(s, rng, slot);
  }
}


/**
 * The air arm's tick: gunships fly, bombs fall, and the sortie clocks run.
 *
 * The ORDER is C#'s and it is protocol. Army.Update steps the helicopters and
 * then the bombs, finishes with Reinforce, and only then does Battlefield call
 * LaunchSorties - so a gunship sent this tick first moves on the next one, and
 * every draw the air makes sits between the ground fight's shooting and the
 * replacements walking on. Moving any of these three calls past another moves
 * the whole war, not just the aircraft.
 *
 * Split into three functions for reading only; they are called back to back.
 */
function stepHelicopters(s, rng, seamAt, groundAt) {
  const h = { side: 1, x: 0, y: 0, z: 0, dir: 0, t: 0, dropIn: 0 };
  for (let i = 0; i < MAX_HELIS; i++) {
    const b = heliBase(i);
    if (s[b + H_STATE] === 0) continue;
    h.side = s[b + H_SIDE]; h.x = s[b + H_X]; h.y = s[b + H_Y]; h.z = s[b + H_Z];
    h.dir = s[b + H_DIR]; h.t = s[b + H_T]; h.dropIn = s[b + H_DROPIN];

    const r = stepHeli(h, rng, seamAt, groundAt, TICK_DT);

    s[b + H_X] = h.x; s[b + H_Y] = h.y; s[b + H_Z] = h.z;
    s[b + H_T] = h.t; s[b + H_DROPIN] = h.dropIn;

    // Never both in one tick: the drop gate is |x| < 92 and the exit is
    // |x| > 104, so a gunship close enough to drop is nowhere near leaving.
    if (r === AIR_RELEASE) release(s, rng, h, seamAt(h.x), groundAt(h.x, h.z));
    else if (r === AIR_GONE) s[b + H_STATE] = 0;
  }
}

/**
 * Puts a bomb in the first free rack.
 *
 * If every rack is full the bomb is lost, which is the one thing here that the
 * C#'s unbounded List cannot do - and the reason rules.test.js watches the peak
 * rather than trusting the eight. A core that silently swallowed a bomb would
 * diverge from a verifier that had a rack free, and the divergence would be one
 * dead squad at a time with nothing in the state to say why.
 *
 * The draw happens BEFORE the rack is looked for, so a lost bomb still costs
 * the stream what a delivered one costs it. Otherwise a full rack would shift
 * every draw after it and the loss would not be one bomb, it would be the rest
 * of the round.
 */
/**
 * Where this bomb should come down, or NO_AIM.
 *
 * THE RULE IS THE PLAYER'S, NOT C#'s. `Army.Release` drops on a timer and
 * throws across the seam at a random 10-22 m/s - it aims at nothing, and the
 * core copied that. A gunship that flies over an army and lets go on a clock
 * is not tactical, so this core picks something to hit.
 *
 * What is free and what is not: `vx` is inherited from the aircraft and
 * nothing steers the bomb afterwards, so the landing x is decided the moment
 * it leaves the rack. Only z can be aimed. So the target has to be looked for
 * where the bomb is ALREADY going - around `x + vx * fallTime` - and the
 * choice is which clump of living enemies sits nearest the front there.
 *
 * Densest first, ties to the lower index, which is protocol: the scan runs in
 * index order and a different order is a different battle.
 */
function aimPoint(s, h, front, ground) {
  const t = fallTime(sub(h.y, ground));
  if (t <= 0) return NO_AIM;
  const landX = add(h.x, mulFast(mulFast(h.dir, Math.imul(30, ONE)), t));
  const foe = h.side < 0 ? 1 : -1;

  let bestI = -1, bestN = 0;
  for (let i = 0; i < UNITS; i++) {
    const b = unitBase(i);
    if (s[b + U_STATE] === 0 || s[b + U_HP] <= 0) continue;
    if ((s[b + U_SIDE] < 0 ? -1 : 1) !== foe) continue;
    // Within the bomb's own reach of where it is going: one blast radius in x
    // of the landing point, and inside the contested strip in z.
    if (abs(sub(s[b + U_X], landX)) > BOMB_RADIUS) continue;
    if (abs(sub(s[b + U_Z], front)) > Math.imul(40, ONE)) continue;
    let n = 0;
    for (let j = 0; j < UNITS; j++) {
      const c = unitBase(j);
      if (s[c + U_STATE] === 0 || s[c + U_HP] <= 0) continue;
      if ((s[c + U_SIDE] < 0 ? -1 : 1) !== foe) continue;
      if (abs(sub(s[c + U_X], s[b + U_X])) > BOMB_RADIUS) continue;
      if (abs(sub(s[c + U_Z], s[b + U_Z])) > BOMB_RADIUS) continue;
      n = (n + 1) | 0;
    }
    if (n > bestN) { bestN = n; bestI = i; }
  }
  return bestI < 0 ? NO_AIM : s[unitBase(bestI) + U_Z];
}

function release(s, rng, h, front, ground) {
  const b = { side: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  releaseBomb(b, h, rng, front, aimPoint(s, h, front, ground), ground);
  for (let i = 0; i < MAX_BOMBS; i++) {
    const o = bombBase(i);
    if (s[o + B_STATE] !== 0) continue;
    s[o + B_STATE] = 1; s[o + B_SIDE] = b.side;
    s[o + B_X] = b.x; s[o + B_Y] = b.y; s[o + B_Z] = b.z;
    s[o + B_VX] = b.vx; s[o + B_VY] = b.vy; s[o + B_VZ] = b.vz;
    return;
  }
}

function stepBombs(s, groundAt) {
  const b = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  for (let i = 0; i < MAX_BOMBS; i++) {
    const o = bombBase(i);
    if (s[o + B_STATE] === 0) continue;
    b.x = s[o + B_X]; b.y = s[o + B_Y]; b.z = s[o + B_Z];
    b.vx = s[o + B_VX]; b.vy = s[o + B_VY]; b.vz = s[o + B_VZ];

    const down = stepBomb(b, groundAt(b.x, b.z), TICK_DT);

    s[o + B_X] = b.x; s[o + B_Z] = b.z; s[o + B_VY] = b.vy;
    if (!down) { s[o + B_Y] = b.y; continue; }
    s[o + B_Y] = groundAt(b.x, b.z);
    s[o + B_STATE] = 0;
    detonate(s, b.x, b.z);
  }
}

/**
 * A bomb is not a shell: it clears a circle.
 *
 * Everyone on foot inside sixteen metres dies whatever the distance - the blast
 * does not ask whose men they are, which is why 11-29 of the riflemen a round
 * are killed by their own side's aircraft - and armour takes 12 * (1 - d/16),
 * so a tank dies at the centre and walks away from the edge.
 *
 * The armour loop is NOT guarded against units that are already dead, because
 * the C# is not: RemoveAll runs at the end of Update, so a tank killed by a
 * shell earlier in the same frame is still standing there when the bomb goes
 * off. Measured over four seeds and ninety seconds it never once happened
 * (doubleFire 0/0), so it is a latent defect and not a live one, and a guard
 * added here would be a difference from the recording bought for nothing. It
 * is invisible in this core in any case: taking damage off a corpse leaves it a
 * corpse.
 */
function detonate(s, bx, bz) {
  for (let i = 0; i < UNITS; i++) {
    if (isArmour(i)) continue;
    const b = unitBase(i);
    if (blastReach(sub(s[b + U_X], bx), sub(s[b + U_Z], bz)) < 0) continue;
    s[b + U_HP] = 0;
    s[b + U_STATE] = 0;
  }
  for (let i = 0; i < UNITS; i++) {
    if (!isArmour(i)) continue;
    const b = unitBase(i);
    const d = blastReach(sub(s[b + U_X], bx), sub(s[b + U_Z], bz));
    if (d < 0) continue;
    s[b + U_HP] = max(0, sub(s[b + U_HP], bombDamage(d)));
    if (s[b + U_HP] === 0) s[b + U_STATE] = 0;
  }
}

/**
 * The two sortie clocks. Bull first, then Bear, and each side's jitter is drawn
 * BEFORE its gunship, which is the order LaunchSorties runs them in.
 *
 * Both start at zero, so two gunships launch on the first tick of every round
 * and both are wasted: the armies are still at |z| = 77 with the seam between
 * them and the gunships fly the seam. The first killing bomb in the recording
 * is at t = 16.7-26.4 s. That is not a bug to shave off the front of the round
 * - it is what makes air a thing that arrives rather than a thing that is
 * simply on.
 */
function launchSorties(s, rng, seamAt, groundAt) {
  const h = { side: 1, x: 0, y: 0, z: 0, dir: 0, t: 0, dropIn: 0 };
  for (let k = 0; k < 2; k++) {
    const word = k === 0 ? AIR_BULL : AIR_BEAR;
    const side = k === 0 ? -1 : 1;
    s[O_AIR + word] = sub(s[O_AIR + word], TICK_DT);
    if (s[O_AIR + word] > 0) continue;
    s[O_AIR + word] = sortieWait(rng);
    // Drawn before a slot is looked for, for the reason release() is: a sortie
    // that finds no slot must still cost the stream what one that flies costs
    // it, or the loss is the whole rest of the round rather than one gunship.
    launchHeli(h, rng, side, seamAt, groundAt);
    for (let i = 0; i < MAX_HELIS; i++) {
      const b = heliBase(i);
      if (s[b + H_STATE] !== 0) continue;
      s[b + H_STATE] = 1; s[b + H_SIDE] = h.side;
      s[b + H_X] = h.x; s[b + H_Y] = h.y; s[b + H_Z] = h.z;
      s[b + H_DIR] = h.dir; s[b + H_T] = h.t; s[b + H_DROPIN] = h.dropIn;
      break;
    }
  }
}

// re-exported so the draw order lives in one place
import { below } from './rng.js';
const nextBelow = below;

/**
 * One tick.
 *
 * `practice` is an INPUT, not a setting. It rides in the transcript with
 * everything else, so a node replaying the run sees exactly which ticks were
 * shielded - which is the difference between a practice mode and a cheat.
 */

/**
 * The solid armour, from the core's OWN tanks.
 *
 * This used to arrive from Unity: `CoreDrivenTruck.UploadArmour` ran every
 * frame out of `field.Army` and handed the positions in through `setArmour`.
 * That was per-tick host input which is not player input, so a node replaying
 * a transcript had nothing to supply it - measured, `st.armour.n` was 0 at
 * every tick of every golden vector, and the truck drove through twenty-four
 * of its own tanks. Feeding one host tank at the truck's position turned a
 * round that ended at x = +130 into one that ended at x = -130, which is the
 * whole of why the round was not replayable.
 *
 * Called at the TOP of the step, before the vehicle moves, so it reads the
 * positions the army finished last tick with. That is deliberately the same
 * one-frame staleness Unity had - it uploaded the previous frame's army - and
 * `resolveArmour`'s own comment relies on it: the truck is pushed out of where
 * the tanks were, not where they are about to be.
 */
function fillArmour(st) {
  const s = st.i32;
  const xz = st.armour.xz;
  let n = 0;
  for (let i = 0; i < UNITS; i++) {
    if (!isArmour(i)) continue;
    const b = unitBase(i);
    if (s[b + U_STATE] === 0) continue;
    xz[Math.imul(n, 2)] = s[b + U_X];
    xz[Math.imul(n, 2) + 1] = s[b + U_Z];
    n++;
  }
  st.armour.n = n;
}

export function step(st, throttle, steer, brake, handbrake, practice) {
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  const T = O_TRUCK;
  s[O_TICK] = (s[O_TICK] + 1) | 0;

  // ---- 0. the liquidation queue ------------------------------------------
  // First, before anything moves, and it draws no random number. The order of
  // a tick is protocol: a strike that armed after the army had stepped would
  // be a different battle, and a verifier stepping it the other way round
  // would get a different digest from the same inputs.
  s[O_LIQ + L_LAST] = s[O_LIQ + L_PENDING];
  s[O_LIQ + L_PENDING] = 0;
  if (s[O_LIQ + L_LAST] > 0) {
    // One accepted liquidation, one strike, in the tick it is consumed. The
    // load is the size itself in the unit it arrived in; nothing is scaled
    // here, because the crater that reads it is its own step.
    const at = strikePoint(s, (x) => frontlineZ(st.tape, x, HALF_X, HALF_Z));
    s[O_STRIKE + K_STATE] = 1;
    s[O_STRIKE + K_X] = at.x;
    s[O_STRIKE + K_Z] = at.z;
    s[O_STRIKE + K_LOAD] = s[O_LIQ + L_LAST];
    s[O_STRIKE + K_SERIAL] = (s[O_STRIKE + K_SERIAL] + 1) | 0;

    // The hole, at the impact and nowhere near it.
    const hole = craterOf(s[O_LIQ + L_LAST]);
    const slot = craterBase(craterSlot(s));
    s[slot + C_X] = at.x;
    s[slot + C_Z] = at.z;
    s[slot + C_R] = hole.r;
    s[slot + C_D] = hole.d;
    s[slot + C_ROUNDS] = hole.rounds;
  } else {
    s[O_STRIKE + K_STATE] = 0;
  }
  fillArmour(st);

  // ---- 1. vehicle --------------------------------------------------------
  const v = {
    x: s[T + T_X], z: s[T + T_Z], heading: s[T + T_HEADING],
    vx: s[T + T_VX], vz: s[T + T_VZ], angVel: s[T + T_ANGVEL],
    // Last tick's speed, not zero: the steering lock falls away with speed,
    // and rebuilding this with a zero every tick left the truck on full lock
    // at 26 m/s - the correction below would have had nothing to correct.
    steerAngle: s[T + T_STEER], speed: s[T + T_WHEEL],
    // Condition reaches the driving. `T_FLAGS` bit 0 is the pull direction,
    // set once at init from the seed - see `vehicleStep`.
    hp: s[T + T_HP], pull: (s[T + T_FLAGS] & 1) === 0 ? -1 : 1,
  };
  // The slope the truck is standing on, along its own nose.
  const grade = gradeAlong((gx, gz) => surfaceAt(st, gx, gz), s[T + T_X], s[T + T_Z],
                           sin(s[T + T_HEADING]), cos(s[T + T_HEADING]));
  vehicleStep(v, throttle, steer, brake, handbrake, TICK_DT, grade);
  // Out of the walls before the position is committed. After the vehicle
  // step, so it corrects where the truck WOULD have got to rather than
  // steering it away in advance - a wall has to be something you drive into.
  resolveSolids(v, st.solids,
                sin(v.heading), cos(v.heading),
                surfaceAt(st, v.x, v.z));

  // And out of the armour. Last tick's tank positions, because the army has
  // not moved yet this tick - one frame stale, sixteen milliseconds, and it
  // keeps the phase order exactly as it was.
  v.fx = sin(v.heading); v.fz = cos(v.heading);
  v.impact = 0;
  resolveArmour(v, st.armour.xz, st.armour.n);

  // The hardest armour impact this tick, for whatever applies damage.
  if (v.impact > s[T + T_IMPACT]) s[T + T_IMPACT] = v.impact;

  // And what it costs. Priced from THIS tick's impact rather than from the
  // accumulated word, which the host reads and clears on its own clock - the
  // rule should charge for the crash that just happened, not for whatever is
  // still sitting in the mailbox.
  //
  // `practice` withholds it exactly as it withholds courier fire; the apron
  // does not, because the core has no invulnerable radius - that is a listed
  // gap and not something to invent here.
  if (!practice && s[O_SCORE + S_STATE] === RUN_LIVE && v.impact > CRASH_FLOOR) {
    if (v.impact >= CRASH_WRITE_OFF) s[T + T_HP] = 0;
    else s[T + T_HP] = max(0, sub(s[T + T_HP],
                                  div(mulFast(v.impact, CRASH_POINTS), TRUCK_ARMOUR)));
  }

  s[T + T_X] = clamp(v.x, -HALF_X, HALF_X);
  s[T + T_Z] = clamp(v.z, -HALF_Z, HALF_Z);
  s[T + T_HEADING] = v.heading;
  s[T + T_VX] = v.vx; s[T + T_VZ] = v.vz;
  s[T + T_ANGVEL] = v.angVel; s[T + T_STEER] = v.steerAngle;
  s[T + T_WHEEL] = v.speed;
  s[T + T_THROTTLE] = throttle;

  // The live craters, gathered once for the whole army rather than eight
  // slots re-read per unit per tick. Index order, which is protocol.
  const craters = { n: 0, r: [] };
  for (let i = 0; i < MAX_CRATERS; i++) {
    const b = craterBase(i);
    if (s[b + C_R] <= 0 || s[b + C_ROUNDS] <= 0) continue;
    craters.r.push(s[b + C_X], s[b + C_Z], s[b + C_R]);
    craters.n = (craters.n + 1) | 0;
  }

  // ---- 2. army -----------------------------------------------------------
  const tx = s[T + T_X], tz = s[T + T_Z];
  const seamZ = frontlineZ(st.tape, tx, HALF_X, HALF_Z);
  // Damage dealt to the truck this tick, in Q16.16 rather than a count of
  // hits. It used to be a tally of flat points because every courier hit was
  // worth exactly one; a tank shell is Rand(5, 11), so the truck's damage has
  // to be carried at its real size. The rifle still adds exactly ONE until
  // its own half of (j) is done.
  let courierDmg = 0;
  const u = { x: 0, z: 0, hp: 0, heading: 0, cooldown: 0, armour: false, side: 1, crowded: false, engaged: false, foeX: 0 };

  // A read-only view of any unit, for target selection. Declared before the
  // loop that uses it, unlike the scoring one further down.
  const peek = { x: 0, z: 0, hp: 0, armour: false, side: 1, crowded: false, engaged: false, foeX: 0 };
  const peekAt = (i) => {
    const pb = unitBase(i);
    peek.x = s[pb + U_X]; peek.z = s[pb + U_Z]; peek.hp = s[pb + U_HP];
    peek.side = s[pb + U_SIDE]; peek.armour = isArmour(i);
    return peek;
  };
  // Tanks are pushed out of each other BEFORE anything moves, which is where
  // `Army.Update` does it - the first three lines of it, over every armour
  // pair, ahead of StepArmour and StepInfantry. The position is protocol: a
  // separation applied after the step would be resolving last tick's overlap
  // against this tick's positions.
  for (let i = 0; i < UNITS; i++) {
    if (!isArmour(i)) continue;
    const ab = unitBase(i);
    // Alive is U_STATE, not U_HP: that is what `reinforce` counts and what the
    // crowding scan skips on, and an unfilled slot is state 0. C# has no such
    // question - `Army.Update` removes the dead from `Armour` before this runs.
    if (s[ab + U_STATE] === 0) continue;
    for (let j = i + 1; j < UNITS; j++) {
      if (!isArmour(j)) continue;
      const bb = unitBase(j);
      if (s[bb + U_STATE] === 0) continue;
      separatePair(s, ab, bb, U_X, U_Z, U_SIDE);
    }
  }

  for (let i = 0; i < UNITS; i++) {
    const b = unitBase(i);
    u.x = s[b + U_X]; u.z = s[b + U_Z]; u.hp = s[b + U_HP];
    u.heading = s[b + U_HEADING]; u.cooldown = s[b + U_COOLDOWN];
    // Every fourth unit is a tank, and it walks at a tank's pace. This was
    // left false on the stepping view, so armour closed at infantry speed -
    // 2.6 m/s where the C# army does 6.8 - and the two arms arrived together
    // instead of the armour reaching the line first.
    u.armour = isArmour(i);
    u.side = s[b + U_SIDE];
    // The post he is holding, read fresh every tick: the anchors walk.
    u.anchor = u.armour ? 0 : s[squadWord(u.side, s[b + U_TARGET])];

    // Is anything of the other side too close? Decided before the step, from
    // the positions everyone had at the start of the tick, so the order units
    // are visited in cannot change who gives ground.
    // The nearest enemy, and whether it is close enough to crowd us. Both
    // read from the positions everyone held at the START of the tick, so the
    // order units are visited in cannot decide who gives ground or who is
    // chasing whom.
    u.crowded = false;
    u.engaged = false;
    u.foeX = 0;
    // ARMOUR ONLY, on both sides of the test, because Army.NearestEnemy walks
    // the Armour list and nothing else. A rifleman has no scan at all here -
    // he has no crowding rule to feed and picks his target when he fires - and
    // a tank is not crowded by riflemen, only by another tank.
    if (u.armour) {
      let nearest = ARMOUR_RANGE;   // plain name: the bundler cannot alias
      for (let j = 0; j < UNITS; j++) {
        if (j === i || !isArmour(j)) continue;
        const jb = unitBase(j);
        if (s[jb + U_STATE] === 0 || s[jb + U_SIDE] === u.side) continue;
        const ddx = sub(s[jb + U_X], u.x), ddz = sub(s[jb + U_Z], u.z);
        if (abs(ddx) > nearest || abs(ddz) > nearest) continue;
        const dd = length2(ddx, ddz);
        if (dd < BACKOFF_RANGE) u.crowded = true;
        if (dd < nearest) { nearest = dd; u.engaged = true; u.foeX = s[jb + U_X]; }
      }
    }
    // Moves the unit. Its return value used to say "a courier hit landed"; the
    // tank's courier weapon is gone and the choice lives in the gun below, so
    // there is nothing left to report and the call is made for its effect.
    // THE FRONT AT THIS UNIT'S OWN x, NOT AT THE TRUCK'S.
    //
    // `seamZ` above is one number, taken where the truck happens to be
    // standing, and it used to be handed to every unit on the field. The
    // front is not a number, it is a curve: measured across the map it runs
    // from +37.6 m at x=-44 to -40.5 m at x=+66, a spread of about 80 m. So
    // the whole army was marching onto a flat line whose height was set by
    // the player's position, and slid up and down as he drove.
    //
    // Measured against the line that actually exists, nobody was on it:
    // infantry sat 40 to 59 m behind it on one side and scattered to a
    // standard deviation of 51.7 m on the other, and the armour was the same.
    // Against the FLAT line the same units looked tidy, which is why it went
    // unseen - the ruler was the fault.
    //
    // `Army.cs:557` takes `FrontlineAt(v.x)` per tank and `:651`
    // `FrontlineAt(s.x)` per man. This is that, not a new rule. The truck's
    // own seam is still what the truck is measured against, so `seamZ` stays
    // for the callers below it.
    const unitSeam = frontlineZ(st.tape, u.x, HALF_X, HALF_Z);
    stepUnit(u, rng, unitSeam, tx, tz, HALF_X, HALF_Z, TICK_DT, i, s[O_TICK], craters);

    // Armour fires on armour. Drawn in index order, always, so the transcript
    // replays: a tank that fires earlier changes what the ones after it see.
    if (u.armour && u.hp > 0) {
      if (s[b + U_TARGET] > 0) s[b + U_TARGET] = (s[b + U_TARGET] - 1) | 0;
      else {
        const foe = pickTarget(peekAt, UNITS, i, u.x, u.z, u.side);
        if (foe >= 0) {
          // Rolled whether it hits BEFORE the reload is set, and the reload is
          // set either way: a miss costs a shell and the time to load another.
          const connects = nextBelow(rng, 1000) < HIT_PER_MIL;
          const fb = unitBase(foe);

          // THE COURIER IS A TARGET CHOICE, not a second gun. Army.cs:696-706:
          // the truck outranks the enemy the tank had picked when it is inside
          // CourierRange and NEARER than that enemy - "it is in everybody's way
          // and nobody's army". Heat is zero in every recording, which drops
          // the two widening terms and leaves a plain 34 m and a plain nearer.
          //
          // Axes before length2, the guard item (m) put on the old weapon,
          // with its threshold moved to 34 with the range. Dropping it here
          // would bring the overflow back through a wider gate: past ~181.5 m
          // the sum of squares wraps and length2 returns ZERO, which read as
          // the truck standing on the tank. The foe needs no such guard - it
          // is inside ARMOUR_RANGE by construction.
          // AND HOW HARD THE LOAD IS HUNTED WIDENS BOTH HALVES OF THAT.
          //
          // `S_HEAT` is zero unless a host has said otherwise, and at zero
          // every line below reduces to the plain 34 m and the plain nearer
          // that the recordings were taken at. Above zero it is `Army.cs`'s
          // own rule: the reach grows by 1.4 x heat and the truck outranks a
          // foe up to 2.5 x heat nearer than it.
          //
          // The axis guard from item (m) moves WITH the reach, as it did when
          // the threshold moved to 34: at full heat that is 81.6 m, still far
          // under the ~181.5 m where the sum of squares wraps and `length2`
          // returns zero - which read as the truck standing on the tank.
          const heat = s[O_SCORE + S_HEAT];
          const reachA = courierReach(heat, true);
          const dxTruck = sub(u.x, tx), dzTruck = sub(u.z, tz);
          let onCourier = false;
          if (abs(dxTruck) <= reachA && abs(dzTruck) <= reachA) {
            const toTruck = length2(dxTruck, dzTruck);
            if (toTruck < reachA)
              onCourier = outranksTheFoe(
                toTruck, length2(sub(u.x, s[fb + U_X]), sub(u.z, s[fb + U_Z])), heat);
          }

          if (connects) {
            // One draw either way, and in hundredths like the shell's own
            // damage, so the stream does not change shape with the target.
            if (onCourier) {
              // Scaled AFTER the draw, so heat changes what a shell does and
              // never what the stream draws: one number either way, in the
              // same order, whatever the load.
              const shell = add(COURIER_DAMAGE_MIN,
                    idiv(Math.imul(nextBelow(rng, 100), COURIER_DAMAGE_SPAN), 100));
              courierDmg = add(courierDmg, shellForHeat(shell, heat));
            } else {
              const hurt = add(DAMAGE_MIN, idiv(Math.imul(nextBelow(rng, 100), DAMAGE_SPAN), 100));
              s[fb + U_HP] = max(0, sub(s[fb + U_HP], hurt));
              if (s[fb + U_HP] === 0) s[fb + U_STATE] = 0;
            }
          }
          s[b + U_TARGET] = (RELOAD_MIN + nextBelow(rng, RELOAD_SPAN)) | 0;
        }
      }
    }
    // The rifle, in the same place and for the same reason: it reads the other
    // units, so it cannot live inside stepUnit.
    //
    // One clock and one shot on it, which is Army.StepInfantry's shape. The
    // target is picked when the shot goes off, and the reload is set BEFORE
    // the hit is rolled, because the C# sets it either way and a stream that
    // draws in a different order is a different program.
    //
    // THE FOE IS LOOKED FOR FIRST, and that is the whole of the selection rule.
    // Army.StepInfantry finds the nearest enemy rifleman, and a man with none
    // inside 26 m sets a look clock and fires at NOTHING - not at the truck
    // standing beside him. Only once he has a target does the courier come
    // into it, and only when the truck is nearer than that target. This is why
    // six rifle rounds hit a truck parked in the middle of the fight for
    // ninety seconds where this core used to land two hundred and forty-six
    // shots: it checked the truck first and let it win unconditionally.
    if (!u.armour && u.hp > 0) {
      if (s[b + U_COOLDOWN] > 0) s[b + U_COOLDOWN] = (s[b + U_COOLDOWN] - 1) | 0;
      else {
        // Rejected on each axis BEFORE length2, which is what every other
        // scan in the core already does - pickRifleTarget (army.js:320),
        // pickTarget (:379), threatAt (:423), the armour crowding scan below
        // (sim.js:676) and the solids scan (solids.js:56-66).
        //
        // length2 squares its arguments in Q16.16, so a separation past about
        // 181.5 m overflows the sum of squares past 2^31, wraps it negative
        // and comes back as a distance of ZERO. Without this the truck read as
        // standing on any man far enough away: measured, 19-21% of the
        // approach's rifle clocks were spent firing a 2.5-4.5 s reload at a
        // truck 200 m off, and the truck took the hits. The trap is the one
        // army.js:417-421 already had written down.
        const foe = pickRifleTarget(peekAt, UNITS, i, u.x, u.z, u.side);
        if (foe < 0) {
          s[b + U_COOLDOWN] = (RIFLE_LOOK_TICKS + nextBelow(rng, RIFLE_LOOK_TICKS_SPAN)) | 0;
        } else {
          s[b + U_COOLDOWN] = (RIFLE_RELOAD_TICKS + nextBelow(rng, RIFLE_RELOAD_TICKS_SPAN)) | 0;
          const connects = nextBelow(rng, 1000) < RIFLE_HIT_PER_MIL;
          const fb = unitBase(foe);

          // The truck takes the shot only if it is inside the rifle's reach
          // AND nearer than the man he had picked (Army.cs:725-731, Heat zero,
          // which drops both widening terms). Axes before length2, the guard
          // from (m): past ~181.5 m the sum of squares wraps and length2
          // returns ZERO, and the truck read as standing on the man. Measured
          // before that guard, 19-21% of the approach's rifle clocks were
          // spent firing at a truck 200 m off. The foe needs no guard - he is
          // inside RIFLE_RANGE by construction.
          // The same widening in the rifleman's own terms: 0.8 x heat on his
          // reach, not the tank's 1.4, and the same 2.5 on outranking. His
          // ROUND is not scaled - the C# scales the shell and not the rifle,
          // and the two damage bands are how the weapons are told apart.
          const heatR = s[O_SCORE + S_HEAT];
          const reachR = courierReach(heatR, false);
          const dxTruck = sub(u.x, tx), dzTruck = sub(u.z, tz);
          let onCourier = false;
          if (abs(dxTruck) <= reachR && abs(dzTruck) <= reachR) {
            const toTruck = length2(dxTruck, dzTruck);
            if (toTruck < reachR)
              onCourier = outranksTheFoe(
                toTruck, length2(sub(u.x, s[fb + U_X]), sub(u.z, s[fb + U_Z])), heatR);
          }

          if (connects) {
            // Rand(1.5, 3.5) at the truck, one point at a man. Drawn in
            // hundredths like every other damage in this file, so it is one
            // draw either way and the stream keeps its shape.
            if (onCourier) {
              courierDmg = add(courierDmg,
                add(COURIER_RIFLE_MIN,
                    idiv(Math.imul(nextBelow(rng, 100), COURIER_RIFLE_SPAN), 100)));
            } else {
              s[fb + U_HP] = max(0, sub(s[fb + U_HP], RIFLE_DAMAGE));
              if (s[fb + U_HP] === 0) s[fb + U_STATE] = 0;
            }
          }
        }
      }
      u.cooldown = s[b + U_COOLDOWN];
    }

    s[b + U_X] = u.x; s[b + U_Z] = u.z;
    s[b + U_HEADING] = u.heading; s[b + U_COOLDOWN] = u.cooldown;
  }
  // The army still fires, still walks, still counts towards danger - only the
  // damage is withheld. Skipping the shooting entirely would change the draw
  // order and make a practice run replay differently from a live one, which
  // would defeat the point of practising.
  if (practice) s[O_SCORE + S_PRACTICE] = 1;
  else if (courierDmg > 0 && s[O_SCORE + S_STATE] === RUN_LIVE)
    s[T + T_HP] = max(0, sub(s[T + T_HP], div(courierDmg, TRUCK_ARMOUR)));

  // ---- fallout -----------------------------------------------------------
  // The truck is irradiated while it is in a crater. Withheld by `practice`
  // and only while the run is live, exactly as the courier's damage above is,
  // because a practice run that killed you would not be practice.
  //
  // After the truck has moved and after the army has fired, so the position
  // read is the one the tick ends with. The order is protocol.
  if (!practice && s[O_SCORE + S_STATE] === RUN_LIVE) {
    for (let i = 0; i < MAX_CRATERS; i++) {
      const b = craterBase(i);
      const R = s[b + C_R];
      if (R <= 0 || s[b + C_ROUNDS] <= 0) continue;
      const dx = sub(s[T + T_X], s[b + C_X]), dz = sub(s[T + T_Z], s[b + C_Z]);
      if (abs(dx) > R || abs(dz) > R) continue;
      const r = length2(dx, dz);
      if (r >= R) continue;
      const f = div(r, R);
      const dose = mulFast(mulFast(falloutRate(R), sub(ONE, mulFast(f, f))), TICK_DT);
      s[T + T_HP] = max(0, sub(s[T + T_HP], dose));
    }
  }

  // The squads walk. Between the unit loop and the air because that is where
  // Army.Update runs DriftSquads, and it decides where the men are standing
  // when the bombs go off.
  driftSquads(s);

  // ---- 2b. air -----------------------------------------------------------
  // Gunships, then bombs, then replacements, then the sortie clocks. That is
  // Army.Update's own order with Battlefield.LaunchSorties after it, and it is
  // protocol: every one of these draws from the same stream the ground fight
  // just used.
  //
  // The seam is read at the AIRCRAFT's x, not the truck's. The unit loop above
  // takes one seam for the whole army because it is following the truck; a
  // gunship crosses the entire two-hundred-metre corridor in ten seconds and
  // the seam it stands off is the one under its own nose, as FrontlineAt(h.x)
  // has it.
  const seamAt = (x) => frontlineZ(st.tape, x, HALF_X, HALF_Z);
  const groundAt = (x, z) => surfaceAt(st, x, z);
  stepHelicopters(s, rng, seamAt, groundAt);
  stepBombs(s, groundAt);

  // Replacements walk on last, after everyone has moved and fired, which is
  // where C# Update puts it - RemoveAll, then Reinforce. Anything drawn here
  // is drawn after the tick's shooting, so moving this call moves the whole
  // army.
  reinforce(s, rng);
  launchSorties(s, rng, seamAt, groundAt);

  // Nobody left standing inside the cab.
  //
  // AFTER the whole army step, because that is where `Battlefield` calls it:
  // `Army.Update(dt)` at :105 - which itself ends on RemoveAll and Reinforce -
  // then `RunOver` at :144, then `ClearPath` at :153. Run-over will go
  // immediately above this when it is ported; the order is the game's and not
  // a preference, since clearing first would move the men out of the wheels
  // before the wheels were asked who was under them.
  //
  // Infantry only, exactly as C# does it. `resolveArmour` up in the vehicle
  // section already pushes the TRUCK out of the tanks, and C#'s own comment
  // says why nothing should push the tanks as well: two systems arguing over
  // one overlap have no radius that satisfies both.
  //
  // A WRECK CLEARS NOBODY. `Battlefield` wraps this whole block in
  // `if (courier != null && (health == null || !health.IsDestroyed))`, so once
  // the truck is written off C# stops both running men down and pushing them
  // out. The first version of this port had no such guard and went on shoving
  // riflemen out of a hulk the game considers gone.
  //
  // The core's quantity for "written off" is `T_HP`, and NOT `S_STATE`: the
  // state word is recomputed down in the score section, after this, so here it
  // still holds last tick's value and would let a wreck clear for one more
  // tick. `T_HP` is current at this point because the courier damage above
  // has already come off it. It is also not `TruckHealth` and not its `armour`
  // divisor - that is the two-owner question and it is not being decided here.
  //
  // Run-over goes INSIDE this brace when it is ported, because it shares the
  // same `if` in the game and not merely a neighbouring one.
  if (s[T + T_HP] > 0) {
    const tx2 = s[T + T_X], tz2 = s[T + T_Z];
    // The truck's own velocity, never a host's and never `T_WHEEL`: see
    // `runOver` in rules/army.js for what each of those would cost.
    const speed = truckSpeed(s[T + T_VX], s[T + T_VZ]);
    // Run-over FIRST and clearing second, which is Battlefield's order -
    // `RunOver` at :144, `ClearPath` at :153. The other way round would move
    // the men out of the wheels before the wheels were asked who was under
    // them, and the rule would kill almost nobody.
    for (let i = 0; i < UNITS; i++) {
      if (isArmour(i)) continue;
      const b = unitBase(i);
      if (s[b + U_STATE] === 0) continue;
      if (runOver(s, b, tx2, tz2, speed, U_X, U_Z)) {
        s[b + U_HP] = 0;
        s[b + U_STATE] = 0;
      }
    }
    for (let i = 0; i < UNITS; i++) {
      if (isArmour(i)) continue;
      const b = unitBase(i);
      if (s[b + U_STATE] === 0) continue;
      clearOfTruck(s, b, tx2, tz2, U_X, U_Z);
    }
  }

  // ---- 3. score ----------------------------------------------------------
  // danger is guns in range, not distance to a line
  const view = (i) => {
    const b = unitBase(i);
    return { x: s[b + U_X], z: s[b + U_Z], hp: s[b + U_HP],
             armour: (i & ARMOUR_MASK) === 0 };
  };
  // The apron test now takes the two components and owns its own guard, for
  // the reason spelled out at `earning` in rules/score.js: the distance is the
  // thing that overflows, and this test asks whether the truck is OUTSIDE a
  // radius, so a large axis proves the answer rather than ruling it out.
  const gaining = tx > s[O_SCORE + S_BESTX];
  if (earning(sub(tx, START_X), sub(tz, START_Z), gaining) &&
      s[O_SCORE + S_STATE] === RUN_LIVE) {
    // The danger the player is actually in, from the army they can SEE.
    //
    // This once preferred units the HOST sent, because the core's own were
    // "ghosts nothing draws". They are not ghosts any more - the army is the
    // core's - and `setUnits` had no caller left anywhere in the project, so
    // the preference was a dead branch guarding a dead setter. Both are gone.
    const threat = mulFast(threatAt(view, UNITS, tx, tz), frontWeight(tz, seamZ));
    s[O_SCORE + S_EXPOSURE] = accrue(
      s[O_SCORE + S_EXPOSURE], s[O_SCORE + S_BESTX], tx, threat, s[O_SCORE + S_CARGO]);
  }
  if (gaining) s[O_SCORE + S_BESTX] = tx;
  if (s[O_SCORE + S_STATE] === RUN_LIVE)
    s[O_SCORE + S_ELAPSED] = (s[O_SCORE + S_ELAPSED] + 1) | 0;

  // ---- 4. outcome --------------------------------------------------------
  s[O_SCORE + S_STATE] = outcome(
    s[O_SCORE + S_STATE], tx, tz, s[T + T_HP], s[O_SCORE + S_ELAPSED]);
  if (s[O_SCORE + S_STATE] === RUN_DELIVERED && s[O_SCORE + S_DELIVERED] === 0)
    s[O_SCORE + S_DELIVERED] = scoreOf(
      s[O_SCORE + S_EXPOSURE], s[O_SCORE + S_ELAPSED], s[O_SCORE + S_CARGO]);
  return st;
}

/**
 * The front line at a world x, in metres Q16.16 - for the RENDERER to ask.
 *
 * The core smooths the tape before it lays it across the map
 * (`rules/frontline.js`), and C# does not. Once the units stood on the
 * smoothed line and `TerritoryMap` still painted the raw one, the two
 * disagreed by 22.04 m on average and 49.14 m at worst - at x=68 the core had
 * the front at -8.3 m while the drawing put it at -57.4. A picture that puts
 * the line half a field away from the men standing on it is a lie, so the
 * drawing asks the core rather than working it out again. One rule, one place.
 */
export const frontAt = (st, x) => frontlineZ(st.tape, x | 0, HALF_X, HALF_Z);

/**
 * HOW HARD THE WAR HUNTS THIS LOAD, handed over as round setup.
 *
 * The host knows what went on the bed; the core decides what that costs. It
 * is one word in the hashed state, so a transcript carries it and a verifier
 * replaying the round sees the same fire the player did - which it would not
 * if the widening lived in Unity.
 *
 * Clamped here rather than trusted: a host that sends 4.0 gets 1.0, and the
 * state stays inside the range every rule below reads it in.
 */
export function setHeat(st, q16) {
  st.i32[O_SCORE + S_HEAT] = clamp(q16 | 0, 0, ONE);
  return true;
}

/** What the core is currently hunting this load at, 0..ONE. */
export const heatOf = (st) => st.i32[O_SCORE + S_HEAT];

export const runScore = (st) =>
  scoreOf(st.i32[O_SCORE + S_EXPOSURE],
                st.i32[O_SCORE + S_ELAPSED],
                st.i32[O_SCORE + S_CARGO]);
