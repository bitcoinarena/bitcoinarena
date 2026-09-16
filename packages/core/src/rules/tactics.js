// ARMOUR TACTICS - WAR_TACTICS.md at the repo root is the spec (the owner 2026-09-16 18:20). This file is its
// implementation; the army step (rules/army.js) only moves a tank to what is handed out here.
//
// Deterministic: every value is an integer function of the round seed word, the tank's roster slot index, the tick
// and the words in O_TACTICS. No draw is taken, so no stream shifts, and every signer node computes the same bits.
//
//   §2 ASSIGNMENT    stable pairs by sorted roster id per side: (0,1), (2,3) ... - never re-paired from the living.
//                    An odd tank is a singleton OVERWATCH on its own slot. In a pair one OVERWATCH, one BOUNDING;
//                    they swap on a period and phase hashed from (seed, side, team) - bounding overwatch.
//                    FRONTAGE: seven slots a side, 27 m apart, a permutation hashed from (seed, side) hands each team a distinct
//                    one; the two sides' permutations are independent - crossfire.
//   §3 DEATH         a widow holds OVERWATCH on the team's slot, no rush. A respawned id rejoins its own pair as
//                    BOUNDING, the partner already holding: the team's role clock restarts with it bounding. Teams
//                    are roster ids, so a new hull never takes another team's partner.
//   §4 WHEN          default hold: hull-down on the overwatch line, reverse slope (rules/army.js picks the spot
//                    behind the crest). After a shot: shoot-and-scoot to the next free slot beside the team, the
//                    side hashed - not away from the truck. Moving between slots the pair keeps its two depth lines:
//                    a staggered column, not bumper to bumper.
//   §1.2 THE TRUCK   nothing here reads the truck. The army shoots it; a touch wrecks it (sim.js).
//
// There is no road in the core: the kill zone every slot covers is the seam band the truck has to cross.
import { ONE, idiv, abs, add, sub, mulFast, sqrt } from '../fixed.js';
import { O_UNITS, U_WORDS, U_STATE } from '../state.js';

export const TEAMS_PER_SIDE = 6;
export const SLOTS_PER_SIDE = 7;
const ROSTER_PER_SIDE = 12;                       // armour slots a side: every 4th unit index, side on bit 2
const SLOT_PITCH = Math.imul(27, ONE);
const FIRST_SLOT = Math.imul(-81, ONE);             // outer tank at 87 m, inside the 88 m field
export const PAIR_HALF = Math.imul(6, ONE);       // each tank of a pair 6 m off the slot's centre line: 12 m apart
                                                  // so the two can leapfrog past each other outside the 12 m bubble
export const FORWARD_LINE = Math.imul(16, ONE);   // §2.5 the bounding tank, from the seam, before any push
export const OVERWATCH_LINE = Math.imul(30, ONE); // §2.5 the overwatch tank, from the seam, before any push
export const FALL_BACK_LINE = Math.imul(34, ONE); // §1.1 overrun falls back to this, less the push
const PUSH_STEP = Math.imul(8, ONE), PUSH_MIN = Math.imul(-8, ONE), PUSH_MAX = Math.imul(24, ONE);
const PUSH_TICKS = 300;                           // §4.10 each team re-reads its odds every 5 s
const PUSH_TAKE_LEAD = 3;                         // §4.10 the lead in tanks (with the objective weight) that takes ground
const PUSH_GIVE_LEAD = 1;                         // §4.10 ...and that gives it
const GUN_M = 46;                                 // §4.10 local odds are read inside the gun's reach
export const SCOOT_TICKS = 600;                   // ten seconds between one team's relocations
const PERIOD_MIN = 360, PERIOD_SPAN = 240;        // a leg of the role swap: 6 to 10 s

// O_TACTICS: [0] seed hash; per team w (bull 0-5, bear 6-11): [1+w] slot 0..6, [13+w] tick of the last scoot,
// [25+w] tick its role clock started, [37+w] the member bounding at that start (+2: it came back alone, §3),
// [49+w] its push depth in Q16.16 metres (§4.10); [61+o] objective o (§4.11): lane in the low byte, holder in the next.
export const TAC_SEED = 0, TAC_SLOT = 1, TAC_SCOOT = 13, TAC_ROLE_START = 25, TAC_ROLE_MEMBER = 37, TAC_PUSH = 49;
export const TAC_OBJ = 61;
export const TAC_WORDS = 64;
export const OBJ_RIDGE = 0, OBJ_HOLLOW = 1, OBJ_GAP = 2, OBJECTIVES = 3;
export const HOLDER_NONE = 0, HOLDER_BULL = 1, HOLDER_BEAR = 2;
const RIDGE_GOAL = Math.imul(16, ONE);            // §4.11 a team on the crest holds the crest
const OBJECTIVE_REST = Math.imul(8, ONE);         // §4.11 home, at an objective, is leaning in
const ALONE = 2;

/** a mod b for a >= 0, b > 0: no raw `%` outside an arithmetic file (tools/check-determinism.js). */
const mod = (a, b) => (a - Math.imul(idiv(a, b), b)) | 0;

/** A 32-bit mix, integers only. */
export function mix(a, b) {
  let h = Math.imul((a ^ Math.imul(b | 0, 0x9e3779b1)) | 0, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h | 0;
}

export const seedHash = (seedWord) => mix(seedWord | 0, 0x7a3c5e11);

/** Roster slot index -> side (-1 bull, +1 bear), roster number 0..11, team, member 0/1. */
export function teamOf(index) {
  const k = ((index | 0) >> 3) & 15;
  return { side: ((index >> 2) & 1) === 0 ? -1 : 1, k, team: k >> 1, member: k & 1 };
}

/** The unit index of the other tank of the pair, or -1 for a singleton. */
export function partnerOf(index) {
  const { k } = teamOf(index);
  const pk = k ^ 1;
  if (pk >= ROSTER_PER_SIDE) return -1;
  return ((pk << 3) | ((index | 0) & 4)) | 0;
}

/** The side's slot permutation, hashed from (seed, side): Fisher-Yates on the hash, no draw. */
export function slotOrder(hash, side) {
  const order = [0, 1, 2, 3, 4, 5, 6];
  let h = mix(hash, side < 0 ? 11 : 23);
  for (let i = SLOTS_PER_SIDE - 1; i > 0; i--) {
    h = mix(h, i);
    const j = mod(h >>> 1, i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order;
}

export const slotX = (slot) => (FIRST_SLOT + Math.imul(slot, SLOT_PITCH)) | 0;
const teamWord = (side, team) => (side < 0 ? 0 : TEAMS_PER_SIDE) + team;
const aliveAt = (s, index) => index >= 0 && s[O_UNITS + Math.imul(index, U_WORDS) + U_STATE] !== 0;

/** The team's swap period and phase, hashed from (seed, side, team). */
function schedule(hash, side, team) {
  const h = mix(mix(hash, side < 0 ? 101 : 103), team);
  const period = PERIOD_MIN + mod(h >>> 1, PERIOD_SPAN);
  return { period, member: (h >>> 11) & 1, phase: mod(h >>> 12, period) };
}

export function initTactics(s, base, seedWord) {
  const hash = seedHash(seedWord);
  s[base + TAC_SEED] = hash;
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) {
    const side = w < TEAMS_PER_SIDE ? -1 : 1, team = mod(w, TEAMS_PER_SIDE);
    const sch = schedule(hash, side, team);
    s[base + TAC_SLOT + w] = slotOrder(hash, side)[team];     // distinct by construction
    s[base + TAC_SCOOT + w] = -SCOOT_TICKS;
    s[base + TAC_ROLE_START + w] = -sch.phase;
    s[base + TAC_ROLE_MEMBER + w] = sch.member;
    s[base + TAC_PUSH + w] = 0;
  }
  for (let o = 0; o < OBJECTIVES; o++) s[base + TAC_OBJ + o] = 0;
}

// =====================================================================================================================
// OBJECTIVES (WAR_TACTICS.md §4.11, the owner 2026-09-16 19:02-19:05): RIDGE, HOLLOW and GAP - three inner lanes read
// from the round's ground, which is a function of the seed alone. Nothing here reads a truck.
// =====================================================================================================================

const OBJ_FIRST_LANE = 1, OBJ_LAST_LANE = 5;      // the outer lanes (+-81 m) are levelled apron and hold the bay
const OBJ_BAND = Math.imul(40, ONE), OBJ_BAND_STEP = Math.imul(4, ONE);   // 21 samples, z = -40..+40 m

/**
 * Picks the three lanes at init. `heightAt(x, z)` is the round's relief (no craters). Each objective is the best of
 * the lanes still free, in the order RIDGE (highest top), HOLLOW (lowest bottom), GAP (smallest relief), ties to the
 * lower slot; a lane next to a taken one is free only when no lane at least two away from every taken one is left.
 */
export function initObjectives(s, base, heightAt) {
  const top = [], bottom = [], relief = [];
  for (let lane = OBJ_FIRST_LANE; lane <= OBJ_LAST_LANE; lane++) {
    const x = slotX(lane);
    let hi = 0, lo = 0;
    for (let z = -OBJ_BAND, n = 0; z <= OBJ_BAND; z += OBJ_BAND_STEP, n++) {
      const h = heightAt(x, z) | 0;
      if (n === 0 || h > hi) hi = h;
      if (n === 0 || h < lo) lo = h;
    }
    top[lane] = hi; bottom[lane] = lo; relief[lane] = (hi - lo) | 0;
  }
  const taken = [];
  const score = [(l) => -top[l], (l) => bottom[l], (l) => relief[l]];    // lower is better
  for (let o = 0; o < OBJECTIVES; o++) {
    let apart = false;
    for (let lane = OBJ_FIRST_LANE; lane <= OBJ_LAST_LANE; lane++) if (freeLane(taken, lane, true)) apart = true;
    let best = -1;
    for (let lane = OBJ_FIRST_LANE; lane <= OBJ_LAST_LANE; lane++) {
      if (!freeLane(taken, lane, apart)) continue;
      if (best < 0 || score[o](lane) < score[o](best)) best = lane;
    }
    taken.push(best);
    s[base + TAC_OBJ + o] = best;
  }
}

function freeLane(taken, lane, apart) {
  for (const t of taken) if (t === lane || (apart && (t === lane - 1 || t === lane + 1))) return false;
  return true;
}

export const objectiveLane = (s, base, o) => s[base + TAC_OBJ + o] & 255;
export const objectiveHolder = (s, base, o) => (s[base + TAC_OBJ + o] >> 8) & 255;

/** A team's objective weight (§4.11): 2 on an objective's lane, 1 beside one, else 0. */
export function objectiveWeight(s, base, slot) {
  let w = 0;
  for (let o = 0; o < OBJECTIVES; o++) {
    const d = slot - objectiveLane(s, base, o);
    if (d === 0) return 2;
    if (d === 1 || d === -1) w = 1;
  }
  return w;
}

/** The push ceiling on a slot (§4.11): 16 on RIDGE's lane, 24 everywhere else. */
const goalOf = (s, base, slot) => (slot === objectiveLane(s, base, OBJ_RIDGE) ? RIDGE_GOAL : PUSH_MAX);

/**
 * THE HOLDER (§4.11), each objective re-read every PUSH_TICKS on a tick hashed from (seed, objective): the side with
 * more living tanks inside the gun's reach of the point `(lane x, seam(lane x))` holds it; equal counts leave it.
 * Information for the player - nothing in the odds reads it.
 */
export function objectiveHolders(s, base, tick, seamAt) {
  const reach = Math.imul(GUN_M, 256);
  for (let o = 0; o < OBJECTIVES; o++) {
    if (mod((tick | 0) + mod(mix(s[base + TAC_SEED], 400 + o) >>> 1, PUSH_TICKS), PUSH_TICKS) !== 0) continue;
    const lane = objectiveLane(s, base, o), px = slotX(lane), pz = seamAt(px) | 0;
    let bull = 0, bear = 0;
    for (let i = 0; i < 96; i += 4) {
      if (!aliveAt(s, i)) continue;
      const b = O_UNITS + Math.imul(i, U_WORDS);
      const dx = (s[b] - px) >> 8, dz = (s[b + 1] - pz) >> 8;
      if (abs(dx) >= reach || abs(dz) >= reach || Math.imul(dx, dx) + Math.imul(dz, dz) >= Math.imul(reach, reach)) continue;
      if (teamOf(i).side < 0) bull++; else bear++;
    }
    const holder = bull > bear ? HOLDER_BULL : bear > bull ? HOLDER_BEAR : objectiveHolder(s, base, o);
    s[base + TAC_OBJ + o] = lane | (holder << 8);
  }
}

/**
 * Whether this tank bounds in this tick (§2.5, §2.6, §3). With its partner alive: the role clock. With its partner
 * dead: a widow holds overwatch - unless this tank is the one that came back while the partner was dead, which
 * holds the forward line as BOUNDING until the partner returns.
 */
export function isBounding(s, base, index, tick) {
  const partner = partnerOf(index);
  const { side, team, member } = teamOf(index);
  const w = teamWord(side, team);
  const roleWord = s[base + TAC_ROLE_MEMBER + w];
  if (!aliveAt(s, partner)) return partner >= 0 && (roleWord & ALONE) !== 0 && (roleWord & 1) === member;
  const { period } = schedule(s[base + TAC_SEED], side, team);
  const leg = idiv((tick | 0) - s[base + TAC_ROLE_START + w], period) & 1;
  return ((roleWord & 1) ^ leg) === member;
}

/** Where a tank goes this tick: its team's slot, its side of the pair, and its depth line. */
export function postOf(s, base, index, tick) {
  const { side, team, member } = teamOf(index);
  const x = (slotX(s[base + TAC_SLOT + teamWord(side, team)]) + (member === 0 ? -PAIR_HALF : PAIR_HALF)) | 0;
  const bounding = isBounding(s, base, index, tick);
  const push = s[base + TAC_PUSH + teamWord(side, team)];
  return { x, depth: ((bounding ? FORWARD_LINE : OVERWATCH_LINE) - push) | 0, bounding, push };
}

/**
 * A tank enters in its own team's lane: the spawn's x draw is still taken (the stream does not shift), and the x it
 * gave is replaced by the tank's post. Measured, a hull entering at a random x walked diagonally through the other
 * teams' lines to reach its own, and those crossings were most of what was left of hulls pressing together.
 */
export function enterInLane(s, base, index) {
  s[O_UNITS + Math.imul(index, U_WORDS)] = postOf(s, base, index, 0).x;
}

const TANK_GAP = Math.imul(12, ONE);              // §1.1 hull to hull, both sides alike

/**
 * A NEW HULL IS NOT PLACED INSIDE ANOTHER'S 12 m (§1.1). The respawn enters in its lane at the back edge, and its
 * partner - or a tank of the neighbouring lane - may still be standing there: measured, a respawn put 10.80 m from its
 * partner, which the separation only undid on the next tick. The new hull keeps its lane x and is moved along z only,
 * just clear of each living tank in index order: back toward its own edge while the field has room (`halfZ`), else
 * forward. Integers; no draw.
 */
export function clearOnEntry(s, index, halfZ) {
  const b = O_UNITS + Math.imul(index, U_WORDS), side = teamOf(index).side;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let j = 0; j < 96; j += 4) {
      if (j === index || !aliveAt(s, j)) continue;
      const o = O_UNITS + Math.imul(j, U_WORDS);
      const dx = sub(s[o], s[b]), dz = sub(s[o + 1], s[b + 1]);
      if (abs(dx) >= TANK_GAP || abs(dz) >= TANK_GAP) continue;
      if (add(mulFast(dx, dx), mulFast(dz, dz)) >= mulFast(TANK_GAP, TANK_GAP)) continue;
      const need = add(sqrt(sub(mulFast(TANK_GAP, TANK_GAP), mulFast(dx, dx))), 66);   // and a millimetre
      const back = side < 0 ? sub(s[o + 1], need) : add(s[o + 1], need);
      s[b + 1] = abs(back) <= halfZ ? back : (side < 0 ? add(s[o + 1], need) : sub(s[o + 1], need));
      moved = true;
    }
    if (!moved) return;
  }
}

/** A tank id came back (§3): it rejoins its own pair as BOUNDING - the team's role clock restarts on it. */
export function onRespawn(s, base, index, tick) {
  const { side, team, member } = teamOf(index);
  const w = teamWord(side, team);
  s[base + TAC_ROLE_START + w] = tick | 0;
  s[base + TAC_ROLE_MEMBER + w] = aliveAt(s, partnerOf(index)) ? member : (member | ALONE);
  enterInLane(s, base, index);
}

/**
 * After a team fired (§4): to the free slot beside it, left or right hashed from (seed, side, team, tick), at most
 * once per SCOOT_TICKS. Beside it, not the next in the side's permutation: measured, that was a median 66 m (p90
 * 132 m) across the field, and the pair drove through the other teams - 92.8% of the ticks where the separation
 * push undid a tank's own step.
 */
export function scoot(s, base, index, tick) {
  const { side, team } = teamOf(index);
  const w = teamWord(side, team);
  if ((tick | 0) - s[base + TAC_SCOOT + w] < SCOOT_TICKS) return false;
  s[base + TAC_SCOOT + w] = tick | 0;
  const here = s[base + TAC_SLOT + w];
  let first = ((mix(mix(mix(s[base + TAC_SEED], side < 0 ? 211 : 223), team), tick | 0) >>> 1) & 1) ? 1 : -1;
  // TOWARD THE OBJECTIVE (§4.3, §4.11): off every objective's lane, the side nearer the nearest one, if that slot is
  // free (a tie between two, the hashed side). On one, as written: teams rotate through the lane.
  let near = SLOTS_PER_SIDE, toward = 0;
  for (let o = 0; o < OBJECTIVES; o++) {
    const d = objectiveLane(s, base, o) - here, a = d < 0 ? -d : d;
    if (a === 0) { near = 0; toward = 0; break; }
    if (a < near) { near = a; toward = d < 0 ? -1 : 1; } else if (a === near && (d < 0 ? -1 : 1) !== toward) toward = 0;
  }
  if (toward !== 0 && !slotHeld(s, base, side, team, here + toward)) first = toward;
  for (let n = 0; n < 2; n++) {
    const next = here + (n === 0 ? first : -first);
    if (next < 0 || next >= SLOTS_PER_SIDE) continue;
    let held = false;
    for (let t = 0; t < TEAMS_PER_SIDE; t++) if (t !== team && s[base + TAC_SLOT + teamWord(side, t)] === next) held = true;
    if (!held) {
      s[base + TAC_SLOT + w] = next;
      if (s[base + TAC_PUSH + w] > goalOf(s, base, next)) s[base + TAC_PUSH + w] = goalOf(s, base, next);   // onto the crest
      return true;
    }
  }
  return false;                                   // hemmed in both sides: hold, and try again after the next shot
}

function slotHeld(s, base, side, team, slot) {
  for (let t = 0; t < TEAMS_PER_SIDE; t++) if (t !== team && s[base + TAC_SLOT + teamWord(side, t)] === slot) return true;
  return false;
}

/**
 * PRESSURE (§4.10): every PUSH_TICKS, on a tick hashed per team, a team counts the living tanks of each side inside
 * the gun's reach of its slot on the seam - from the positions at the start of the tick - and takes ground (+8 m, up to
 * 24), gives ground (-8 m, down to -8) or drifts one step back toward 0. A widow never pushes: it drifts to 0.
 * `seamAt(x)` is the front's z at x.
 */
export function pressure(s, base, tick, seamAt) {
  const hash = s[base + TAC_SEED];
  const reach = Math.imul(GUN_M, 256);
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) {
    const side = w < TEAMS_PER_SIDE ? -1 : 1, team = mod(w, TEAMS_PER_SIDE);
    if (mod((tick | 0) + mod(mix(hash, 300 + w) >>> 1, PUSH_TICKS), PUSH_TICKS) !== 0) continue;
    const px = slotX(s[base + TAC_SLOT + w]), pz = seamAt(px) | 0;
    let own = 0, foe = 0;
    for (let i = 0; i < 96; i += 4) {
      if (!aliveAt(s, i)) continue;
      const b = O_UNITS + Math.imul(i, U_WORDS);
      const dx = (s[b] - px) >> 8, dz = (s[b + 1] - pz) >> 8;
      if (abs(dx) >= reach || abs(dz) >= reach || Math.imul(dx, dx) + Math.imul(dz, dz) >= Math.imul(reach, reach)) continue;
      if (teamOf(i).side === side) own++; else foe++;
    }
    const k0 = Math.imul(team, 2), i0 = (k0 << 3) | (side < 0 ? 0 : 4), i1 = ((k0 + 1) << 3) | (side < 0 ? 0 : 4);
    const widow = aliveAt(s, i0) !== aliveAt(s, i1);
    let push = s[base + TAC_PUSH + w];
    const slot = s[base + TAC_SLOT + w], weight = objectiveWeight(s, base, slot);
    const rest = widow ? 0 : weight === 2 ? OBJECTIVE_REST : 0;
    if (!widow && own + weight >= foe + PUSH_TAKE_LEAD) push = Math.min(goalOf(s, base, slot), push + PUSH_STEP);
    else if (!widow && foe >= own + PUSH_GIVE_LEAD + weight) push = Math.max(PUSH_MIN, push - PUSH_STEP);
    else push = push > rest ? push - PUSH_STEP : push < rest ? push + PUSH_STEP : rest;
    if (push > goalOf(s, base, slot)) push = goalOf(s, base, slot);
    s[base + TAC_PUSH + w] = push | 0;
  }
}

// =====================================================================================================================
// PART B - INFANTRY (WAR_TACTICS.md §8-§12). Same construction: integer hashes of (seed, roster id, tick), no draw.
// =====================================================================================================================

/**
 * A rifleman's roster number 0..35 within his side and his fire team 0..8 (§9.1, §9.2): a rifle index is
 * `k x 8 + side x 4 + j`, j = 1..3, so `r = 3k + j - 1` and the team is `r >> 2` - nine teams of four.
 */
export function rifleTeamOf(index) {
  const k = ((index | 0) >> 3) & 15, j = (index | 0) & 3;
  const r = Math.imul(k, 3) + j - 1;
  return { side: ((index >> 2) & 1) === 0 ? -1 : 1, r, team: r >> 2 };
}

export const FIRE_TEAMS_PER_SIDE = 9;

/** The unit index of fire team `team`'s first man, roster `4 x team` (§9.2: the team stands on his squad). */
export function firstManOf(side, team) {
  const r = Math.imul(team, 4), k = idiv(r, 3), j = mod(r, 3) + 1;
  return (Math.imul(k, 8) + (side < 0 ? 0 : 4) + j) | 0;
}
const REACH_18 = Math.imul(18, ONE);

/**
 * The mean push of the tank teams of `side` whose slot is within 18 m of `anchorX`, rounded to 8 m steps toward 0
 * (§12.1). No team in reach: 0.
 */
export function pushNear(s, base, side, anchorX) {
  let sum = 0, n = 0;
  for (let t = 0; t < TEAMS_PER_SIDE; t++) {
    const w = teamWord(side, t);
    const d = slotX(s[base + TAC_SLOT + w]) - (anchorX | 0);
    if (d > REACH_18 || d < -REACH_18) continue;
    sum += s[base + TAC_PUSH + w]; n++;
  }
  if (n === 0) return 0;
  return Math.imul(idiv(idiv(sum, n), PUSH_STEP), PUSH_STEP) | 0;
}
