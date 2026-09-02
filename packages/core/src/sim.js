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

import { ONE, HALF, add, sub, mulFast, div, idiv, clamp, min, max, abs, length2 } from './fixed.js';
import { seed } from './rng.js';
import { sin, cos } from './trig.js';
import {
  create, unitBase, heliBase, bombBase, MAX_UNITS, O_UNITS, U_WORDS,
  O_TICK, O_RNG, O_TRUCK, O_SCORE, O_ARMY,
  A_ARMOUR_BULL, A_ARMOUR_BEAR, A_RIFLE_BULL, A_RIFLE_BEAR,
  O_AIR, AIR_BULL, AIR_BEAR, MAX_HELIS, MAX_BOMBS,
  H_STATE, H_SIDE, H_X, H_Y, H_Z, H_DIR, H_T, H_DROPIN,
  B_STATE, B_SIDE, B_X, B_Y, B_Z, B_VX, B_VY, B_VZ,
  T_X, T_Z, T_HEADING, T_VX, T_VZ, T_ANGVEL, T_HP, T_CARGO, T_FLAGS,
  T_WHEEL, T_THROTTLE, T_STEER, T_IMPACT,
  S_EXPOSURE, S_ELAPSED, S_BESTX, S_CARGO, S_DELIVERED, S_STATE, S_PRACTICE,
  U_X, U_Z, U_SIDE, U_HP, U_HEADING, U_STATE, U_COOLDOWN, U_TARGET,
  O_SQUADS, SQUADS_PER_SIDE, SQUAD_WORDS,
} from './state.js';
// Named imports, not namespaces. `import * as x` cannot survive concatenation
// into a single browser file - after the import line is stripped, every
// `x.thing` points at nothing - and a real bundler in the trust path is
// exactly what section 3.6 argues against for anything that pins money.
import { vehicleStep } from './rules/vehicle.js';
import { flatGround, gradeAlong, heightAtWorld, DEFAULT_COLS, DEFAULT_ROWS } from './rules/ground.js';
import { noSolids, resolveSolids, resolveArmour, BOX_WORDS } from './rules/solids.js';
import { stepUnit, threatAt, pickTarget, pickRifleTarget, riflePost, RELOAD_MIN, RELOAD_SPAN, DAMAGE_MIN, DAMAGE_SPAN, BACKOFF_RANGE, HIT_PER_MIL, ARMOUR_RANGE, RIFLE_RANGE, RIFLE_HIT_PER_MIL, RIFLE_RELOAD_TICKS, RIFLE_RELOAD_TICKS_SPAN, RIFLE_LOOK_TICKS, RIFLE_LOOK_TICKS_SPAN, RIFLE_HP, RIFLE_DAMAGE } from './rules/army.js';
import { accrue, earning, scoreOf } from './rules/score.js';
import { outcome, RUN_LIVE, RUN_DELIVERED, RUN_WRECKED, RUN_MISSED } from './rules/gate.js';
import { frontlineZ, SAMPLES } from './rules/frontline.js';
import {
  launchHeli, stepHeli, releaseBomb, stepBomb, bombDamage, blastReach, sortieWait,
  AIR_RELEASE, AIR_GONE,
} from './rules/air.js';

export const UNITS = 96;
export const HALF_X = Math.imul(130, ONE);
export const HALF_Z = Math.imul(85, ONE);
const TICK_DT = 1092;                       // 1/60 in Q16.16
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
// Every fourth unit is armour. A mask rather than a modulo: '%' is banned
// outside the arithmetic files, and a power of two makes the ban free.
const ARMOUR_MASK = 3;

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
export function setGround(st, cols, rows, heights) {
  if (cols < 2 || rows < 2 || heights.length < Math.imul(cols, rows)) return false;
  const g = flatGround(cols, rows);
  g.h.set(heights.subarray(0, Math.imul(cols, rows)));
  st.ground = g;
  return true;
}

/**
 * The tanks, as x and z pairs in Q16.16, for this tick.
 *
 * Per-tick input rather than round setup: they move. Recorded with the
 * steering, and replayed from the transcript the same way.
 */
export function setArmour(st, count, xz) {
  const n = Math.imul(count, 2);
  if (count < 0 || xz.length < n) return false;
  const a = new Int32Array(n);
  a.set(xz.subarray(0, n));
  st.armour = { n: count, xz: a };
  return true;
}

/**
 * The whole enemy army for this tick: x, z and kind, three words each.
 *
 * Kind is 1 for armour and 0 for infantry. Both matter and for different
 * reasons - armour is solid and infantry is not, but BOTH count towards the
 * danger the score is paid for, and it was being computed from the core's own
 * invisible units. The player was scored on where ghosts were standing.
 */
export function setUnits(st, count, data) {
  const n = Math.imul(count, 3);
  if (count < 0 || data.length < n) return false;
  const u = new Int32Array(n);
  u.set(data.subarray(0, n));
  st.units = { n: count, u };

  // The solid half, kept separately so the collision does not re-filter it
  // sixty times a second.
  let armour = 0;
  const xz = new Int32Array(Math.imul(count, 2));
  for (let i = 0; i < count; i++) {
    if (u[Math.imul(i, 3) + 2] === 0) continue;
    xz[Math.imul(armour, 2)] = u[Math.imul(i, 3)];
    xz[Math.imul(armour, 2) + 1] = u[Math.imul(i, 3) + 1];
    armour++;
  }
  st.armour = { n: armour, xz };
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

export function groundAt(st, x, z) {
  return heightAtWorld(st.ground, x, z, HALF_X, HALF_Z);
}

export function init(seedWord) {
  const st = create();
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  seed(rng, seedWord);

  s[O_TRUCK + T_X] = START_X;
  s[O_TRUCK + T_Z] = START_Z;
  s[O_TRUCK + T_HEADING] = 16384;           // facing +x, down the map
  s[O_TRUCK + T_HP] = Math.imul(100, ONE);
  s[O_TRUCK + T_CARGO] = 45875;             // 0.7 of a bed
  s[O_SCORE + S_BESTX] = START_X;
  s[O_SCORE + S_CARGO] = 45875;
  s[O_SCORE + S_STATE] = RUN_LIVE;

  st.tape = tape(rng);

  // Flat until the host uploads the relief it is drawing. Flat is the honest
  // default: a core that invents hills the player cannot see is worse than one
  // that drives over a table.
  st.ground = flatGround(DEFAULT_COLS, DEFAULT_ROWS);

  // An empty world until the host says otherwise. Empty is honest: a core
  // inventing walls the player cannot see is worse than one with none.
  st.solids = noSolids();

  // The tanks the player can see are the host's, and it sends them every
  // tick. Empty until it does.
  st.armour = { n: 0, xz: new Int32Array(0) };
  st.units = { n: 0, u: new Int32Array(0) };

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
  s[b + U_TARGET] = -1;

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
    if (r === AIR_RELEASE) release(s, rng, h, seamAt(h.x));
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
function release(s, rng, h, front) {
  const b = { side: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  releaseBomb(b, h, rng, front);
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
/** Reads a host-supplied unit as threatAt wants it. */
function makeHostView(st) {
  const u = { x: 0, z: 0, hp: ONE, armour: false };
  return (i) => {
    const b = Math.imul(i, 3);
    u.x = st.units.u[b]; u.z = st.units.u[b + 1];
    u.armour = st.units.u[b + 2] !== 0;
    return u;
  };
}

export function step(st, throttle, steer, brake, handbrake, practice) {
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  const T = O_TRUCK;
  s[O_TICK] = (s[O_TICK] + 1) | 0;

  // ---- 1. vehicle --------------------------------------------------------
  const v = {
    x: s[T + T_X], z: s[T + T_Z], heading: s[T + T_HEADING],
    vx: s[T + T_VX], vz: s[T + T_VZ], angVel: s[T + T_ANGVEL],
    // Last tick's speed, not zero: the steering lock falls away with speed,
    // and rebuilding this with a zero every tick left the truck on full lock
    // at 26 m/s - the correction below would have had nothing to correct.
    steerAngle: s[T + T_STEER], speed: s[T + T_WHEEL],
  };
  // The slope the truck is standing on, along its own nose.
  const grade = gradeAlong(st.ground, s[T + T_X], s[T + T_Z],
                           sin(s[T + T_HEADING]), cos(s[T + T_HEADING]),
                           HALF_X, HALF_Z);
  vehicleStep(v, throttle, steer, brake, handbrake, TICK_DT, grade);
  // Out of the walls before the position is committed. After the vehicle
  // step, so it corrects where the truck WOULD have got to rather than
  // steering it away in advance - a wall has to be something you drive into.
  resolveSolids(v, st.solids,
                sin(v.heading), cos(v.heading),
                heightAtWorld(st.ground, v.x, v.z, HALF_X, HALF_Z));

  // And out of the armour. Last tick's tank positions, because the army has
  // not moved yet this tick - one frame stale, sixteen milliseconds, and it
  // keeps the phase order exactly as it was.
  v.fx = sin(v.heading); v.fz = cos(v.heading);
  v.impact = 0;
  resolveArmour(v, st.armour.xz, st.armour.n);

  // The hardest armour impact this tick, for whatever applies damage.
  if (v.impact > s[T + T_IMPACT]) s[T + T_IMPACT] = v.impact;

  s[T + T_X] = clamp(v.x, -HALF_X, HALF_X);
  s[T + T_Z] = clamp(v.z, -HALF_Z, HALF_Z);
  s[T + T_HEADING] = v.heading;
  s[T + T_VX] = v.vx; s[T + T_VZ] = v.vz;
  s[T + T_ANGVEL] = v.angVel; s[T + T_STEER] = v.steerAngle;
  s[T + T_WHEEL] = v.speed;
  s[T + T_THROTTLE] = throttle;

  // ---- 2. army -----------------------------------------------------------
  const tx = s[T + T_X], tz = s[T + T_Z];
  const seamZ = frontlineZ(st.tape, tx, HALF_X, HALF_Z);
  let hits = 0;
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
    const r = stepUnit(u, rng, seamZ, tx, tz, HALF_X, HALF_Z, TICK_DT, i);

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
          if (connects) {
            const fb = unitBase(foe);
            const hurt = add(DAMAGE_MIN, idiv(Math.imul(nextBelow(rng, 100), DAMAGE_SPAN), 100));
            s[fb + U_HP] = max(0, sub(s[fb + U_HP], hurt));
            if (s[fb + U_HP] === 0) s[fb + U_STATE] = 0;
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
    // The courier branch is TODAY'S rule and not C#'s, and it is item (j)'s to
    // replace: a C# rifleman fires at the truck only when he already has a man
    // inside 26 m and the truck is nearer than that man, which is why six
    // rifle rounds hit a truck parked in the fight for ninety seconds. What is
    // here shoots the truck whenever it is in range. It does now do it on the
    // rifle's own 2.5-4.5 s reload rather than the 0.7-1.7 s this counter used
    // to run at, because the man only has the one clock.
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
        const dxTruck = sub(u.x, tx), dzTruck = sub(u.z, tz);
        if (abs(dxTruck) <= RIFLE_RANGE && abs(dzTruck) <= RIFLE_RANGE &&
            length2(dxTruck, dzTruck) < RIFLE_RANGE) {
          s[b + U_COOLDOWN] = (RIFLE_RELOAD_TICKS + nextBelow(rng, RIFLE_RELOAD_TICKS_SPAN)) | 0;
          if (nextBelow(rng, 1000) < RIFLE_HIT_PER_MIL) hits = (hits + 1) | 0;
        } else {
          const foe = pickRifleTarget(peekAt, UNITS, i, u.x, u.z, u.side);
          if (foe < 0) {
            s[b + U_COOLDOWN] = (RIFLE_LOOK_TICKS + nextBelow(rng, RIFLE_LOOK_TICKS_SPAN)) | 0;
          } else {
            s[b + U_COOLDOWN] = (RIFLE_RELOAD_TICKS + nextBelow(rng, RIFLE_RELOAD_TICKS_SPAN)) | 0;
            if (nextBelow(rng, 1000) < RIFLE_HIT_PER_MIL) {
              const fb = unitBase(foe);
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
    if (r === 2) hits = (hits + 1) | 0;
  }
  // The army still fires, still walks, still counts towards danger - only the
  // damage is withheld. Skipping the shooting entirely would change the draw
  // order and make a practice run replay differently from a live one, which
  // would defeat the point of practising.
  if (practice) s[O_SCORE + S_PRACTICE] = 1;
  else if (hits > 0 && s[O_SCORE + S_STATE] === RUN_LIVE)
    s[T + T_HP] = max(0, sub(s[T + T_HP], Math.imul(hits, ONE)));

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
  const groundAt = (x, z) => heightAtWorld(st.ground, x, z, HALF_X, HALF_Z);
  stepHelicopters(s, rng, seamAt, groundAt);
  stepBombs(s, groundAt);

  // Replacements walk on last, after everyone has moved and fired, which is
  // where C# Update puts it - RemoveAll, then Reinforce. Anything drawn here
  // is drawn after the tick's shooting, so moving this call moves the whole
  // army.
  reinforce(s, rng);
  launchSorties(s, rng, seamAt, groundAt);

  // ---- 3. score ----------------------------------------------------------
  // danger is guns in range, not distance to a line
  const view = (i) => {
    const b = unitBase(i);
    return { x: s[b + U_X], z: s[b + U_Z], hp: s[b + U_HP],
             armour: (i & ARMOUR_MASK) === 0 };
  };
  const fromStart = length2(sub(tx, START_X), sub(tz, START_Z));
  const gaining = tx > s[O_SCORE + S_BESTX];
  if (earning(fromStart, gaining) && s[O_SCORE + S_STATE] === RUN_LIVE) {
    // The danger the player is actually in, from the army they can SEE.
    //
    // This read the core's own units, which nothing draws - so the score was
    // paid for standing near ghosts and withheld in the middle of a real
    // firefight. The host sends the real ones every tick.
    const hostUnits = st.units && st.units.n > 0;
    const hostView = hostUnits ? makeHostView(st) : null;
    const threat = hostUnits
      ? threatAt(hostView, st.units.n, tx, tz)
      : threatAt(view, UNITS, tx, tz);
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

export const runScore = (st) =>
  scoreOf(st.i32[O_SCORE + S_EXPOSURE],
                st.i32[O_SCORE + S_ELAPSED],
                st.i32[O_SCORE + S_CARGO]);
