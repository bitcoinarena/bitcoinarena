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
import { hullDownHold } from './army.js';

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
export const SCOOT_TICKS = 1200;                  // §4.3 twenty seconds between one team's relocations (re-ruled 20:30)
const PERIOD_MIN = 720, PERIOD_SPAN = 480;        // §2.6 a leg of the role swap: 12 to 20 s (re-ruled 20:30)

// O_TACTICS: [0] seed hash; per team w (bull 0-5, bear 6-11): [1+w] slot 0..6, [13+w] tick of the last scoot,
// [25+w] tick its role clock started, [37+w] the member bounding at that start (+2: it came back alone, §3),
// [49+w] its push depth in Q16.16 metres (§4.10); [61+o] objective o (§4.11): lane in the low byte, holder in the next;
// [64+w] the verdict of the team's last push re-read (§4.10: 0 none, 1 take, 2 give, 3 drift).
export const TAC_SEED = 0, TAC_SLOT = 1, TAC_SCOOT = 13, TAC_ROLE_START = 25, TAC_ROLE_MEMBER = 37, TAC_PUSH = 49;
export const TAC_OBJ = 61, TAC_VERDICT = 64, TAC_ASSAULT = 76, TAC_MARKET = 82;
export const TAC_WORDS = 88;
// [82] the round's open (§4.13 TAC_OPEN, in the tape's unit), [83] samples taken since init, [84] trend (+1 UP, -1 DOWN, 0
// SIDEWAYS), [85] its strength 0-3, [86] lead (+1 BULLS, -1 BEARS, 0 FLAT), [87] the lead's momentum 0-3 (§4.14).
export const MK_OPEN = 0, MK_SAMPLES = 1, MK_TREND = 2, MK_STRENGTH = 3, MK_LEAD = 4, MK_MOMENTUM = 5;
// [76 + 3 x sideIndex] (bull 0, bear 1) the side's ASSAULT (§4.12): target objective in bits 0-3, phase in 4-7, the count of
// assaults it has started from bit 8; [77 + ...] the phase's start tick; [78 + ...] the tick the next may start.
export const ASSAULT_IDLE = 0, ASSAULT_PUSH = 1, ASSAULT_CONSOLIDATE = 2;
const ASSAULT_FIRST = 1200, ASSAULT_GAP = 2700, ASSAULT_GAP_FAVOURED = 1800, ASSAULT_REARM = 1200;
const ASSAULT_TICKS = 1800, CONSOLIDATE_TICKS = 900;
const ASSAULT_REST = Math.imul(16, ONE), ASSAULT_CEILING = Math.imul(40, ONE), ASSAULT_CEILING_BESIDE = Math.imul(32, ONE);
export const VERDICT_NONE = 0, VERDICT_TAKE = 1, VERDICT_GIVE = 2, VERDICT_DRIFT = 3;
const ON_POST = (Math.imul(3, ONE) >> 1) | 0;     // §4.3, §4.10 within 1.5 m of its hold, hull-down pick included
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
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) s[base + TAC_VERDICT + w] = VERDICT_NONE;
  for (let si = 0; si < 2; si++) {
    const a = base + TAC_ASSAULT + Math.imul(3, si);
    s[a] = 0; s[a + 1] = 0;
    s[a + 2] = ASSAULT_FIRST + mod(mix(mix(hash, si === 0 ? 601 : 607), 0) >>> 1, ASSAULT_FIRST);   // 20 to 40 s
  }
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

// =====================================================================================================================
// THE ASSAULT (WAR_TACTICS.md §4.12): a declared attempt by one side on one objective it does not hold - a start, 30 s,
// an end and a result. Dumb on purpose: hashed side, hashed target, fixed length; the odds on the lane decide it.
// =====================================================================================================================

const assaultWord = (base, side) => (base + TAC_ASSAULT + (side < 0 ? 0 : 3)) | 0;
export const assaultTarget = (s, base, side) => s[assaultWord(base, side)] & 15;
export const assaultPhase = (s, base, side) => (s[assaultWord(base, side)] >> 4) & 15;
export const assaultCount = (s, base, side) => s[assaultWord(base, side)] >>> 8;

// =====================================================================================================================
// THE CHART FIGHTS THE WAR (WAR_TACTICS.md §4.14, the owner 2026-09-16 21:30/21:40). Two readings of the tape, re-read on the
// sample tick and never between: the LEAD (newest against the round's open: who is winning the round, supply) and the
// TREND (the colour of the last six finished 10 s candles: who is attacking right now). Chart -> war only: nothing here
// reads the truck, and nothing in the war writes the tape.
// =====================================================================================================================

/**
 * The trend's side for `side`: +1 when the trend is that side's (UP for the bulls, side -1; DOWN for the bears, side +1),
 * -1 when it runs against it, 0 when SIDEWAYS.
 */
export function trendFor(s, base, side) {
  const t = s[base + TAC_MARKET + MK_TREND];
  if (t === 0) return 0;
  return (t > 0) === (side < 0) ? 1 : -1;
}
export const trendStrength = (s, base) => s[base + TAC_MARKET + MK_STRENGTH];

/** §4.14: the trend's side runs the 30-60 s assault clock. */
const isFavoured = (s, base, side) => trendFor(s, base, side) > 0;

/** Round setup (§4.13): the open is the seeded tape's newest sample at init, the trend and lead read from it. */
export function initMarket(s, base, tape) {
  s[base + TAC_MARKET + MK_OPEN] = tape[tape.length - 1];
  s[base + TAC_MARKET + MK_SAMPLES] = 0;
  readMarket(s, base, tape);
}

/** A finished candle's colour (§4.14): +1 green (close above open by 3 bp of the open or more), -1 red, 0 a doji. */
export function candleColour(open, close) {
  const doji = Math.imul(idiv(abs(open), 10000), 3);   // 3 bp of the open
  return close - open > doji ? 1 : open - close > doji ? -1 : 0;
}

/**
 * Re-read lead and trend from the tape (§4.14). A candle is two samples (open = the first, close = the second, §4.15's
 * bucket); the newest finished one ends at the newest sample when an even count of samples has been taken, else one
 * sample earlier. Green: close > open by 3 bp of the open or more; red: below by as much; else a doji, neither.
 */
export function readMarket(s, base, tape) {
  const last = tape.length - 1, count = s[base + TAC_MARKET + MK_SAMPLES];
  const end = last - (count & 1);
  let net = 0;
  for (let c = 0; c < 6; c++) {
    net += candleColour(tape[end - Math.imul(c, 2) - 1], tape[end - Math.imul(c, 2)]);
  }
  const a = net < 0 ? -net : net;
  s[base + TAC_MARKET + MK_TREND] = a < 2 ? 0 : (net > 0 ? 1 : -1);
  s[base + TAC_MARKET + MK_STRENGTH] = a < 2 ? 0 : a < 4 ? 1 : a < 6 ? 2 : 3;
  const open = s[base + TAC_MARKET + MK_OPEN], d = tape[last] - open;
  s[base + TAC_MARKET + MK_LEAD] = d > 0 ? 1 : d < 0 ? -1 : 0;
  const unit = idiv(abs(open), 10000);             // one basis point of the open
  const bp = unit > 0 ? idiv(d < 0 ? -d : d, unit) : 0;
  s[base + TAC_MARKET + MK_MOMENTUM] = bp < 5 ? 0 : bp < 20 ? 1 : bp < 50 ? 2 : 3;
}

/** §4.4 / §11.6 hit threshold under the trend: `per mil + step x strength` for the trend's side, minus for the other. */
export function trendHit(s, base, side, perMil, step) {
  return (perMil + Math.imul(Math.imul(trendFor(s, base, side), step), trendStrength(s, base))) | 0;
}

/**
 * §3 supply for `side`, -3..+3: objectives held minus objectives the other side holds (§4.11), plus the lead's momentum
 * for the side above the open, minus the trend's strength for the side it runs against (§4.14).
 */
export function supplyOf(s, base, side) {
  const mine = side < 0 ? HOLDER_BULL : HOLDER_BEAR;
  let supply = 0;
  for (let o = 0; o < OBJECTIVES; o++) {
    const h = objectiveHolder(s, base, o);
    if (h === mine) supply++; else if (h !== HOLDER_NONE) supply--;
  }
  const lead = s[base + TAC_MARKET + MK_LEAD];
  if (lead !== 0 && (lead > 0) === (side < 0)) supply += s[base + TAC_MARKET + MK_MOMENTUM];
  if (trendFor(s, base, side) < 0) supply -= trendStrength(s, base);
  return supply < -3 ? -3 : supply > 3 ? 3 : supply;
}

/** The assault clock, once per tick at the top of pressure(): starts, succeeds, fails, consolidates, re-arms. */
export function assaultClock(s, base, tick) {
  const hash = s[base + TAC_SEED];
  for (let si = 0; si < 2; si++) {
    const side = si === 0 ? -1 : 1, a = assaultWord(base, side), mine = side < 0 ? HOLDER_BULL : HOLDER_BEAR;
    const word = s[a], target = word & 15, phase = (word >> 4) & 15, n = word >>> 8;
    const gap = (m) => isFavoured(s, base, side)
      ? ASSAULT_GAP_FAVOURED + mod(mix(mix(hash, si === 0 ? 601 : 607), m) >>> 1, ASSAULT_GAP_FAVOURED)   // 30 to 60 s
      : ASSAULT_GAP + mod(mix(mix(hash, si === 0 ? 601 : 607), m) >>> 1, ASSAULT_GAP);                    // 45 to 90 s
    if (phase === ASSAULT_IDLE) {
      // PAUSED for the side the trend runs against (§4.14): no assault starts, and the wait stands still - SIDEWAYS
      // releases the clock where it stood.
      if (trendFor(s, base, side) < 0) { s[a + 2] = (s[a + 2] + 1) | 0; continue; }
      if ((tick | 0) < s[a + 2]) continue;
      let unheld = 0;
      for (let o = 0; o < OBJECTIVES; o++) if (objectiveHolder(s, base, o) !== mine) unheld++;
      if (unheld === 0) { s[a + 2] = ((tick | 0) + ASSAULT_REARM) | 0; continue; }          // holds all three: defends
      let pick = mod(mix(mix(mix(hash, si === 0 ? 613 : 617), n), 1) >>> 1, unheld), chosen = 0;
      for (let o = 0; o < OBJECTIVES; o++) {
        if (objectiveHolder(s, base, o) === mine) continue;
        if (pick === 0) { chosen = o; break; }
        pick--;
      }
      s[a] = chosen | (ASSAULT_PUSH << 4) | Math.imul(n + 1, 256);
      s[a + 1] = tick | 0;
    } else if (phase === ASSAULT_PUSH) {
      if (objectiveHolder(s, base, target) === mine) {                                     // success
        s[a] = target | (ASSAULT_CONSOLIDATE << 4) | Math.imul(n, 256);
        s[a + 1] = tick | 0;
      } else if ((tick | 0) - s[a + 1] >= ASSAULT_TICKS) {                                  // failure
        s[a] = target | (ASSAULT_IDLE << 4) | Math.imul(n, 256);
        s[a + 1] = tick | 0; s[a + 2] = ((tick | 0) + gap(n)) | 0;
      }
    } else if ((tick | 0) - s[a + 1] >= CONSOLIDATE_TICKS) {                                // consolidated
      s[a] = target | (ASSAULT_IDLE << 4) | Math.imul(n, 256);
      s[a + 1] = tick | 0; s[a + 2] = ((tick | 0) + gap(n)) | 0;
    }
  }
}

/**
 * A team's weight, rest and push ceiling on `slot` (§4.10-§4.12). Outside the side's assault lanes, §4.11 as before
 * (w 2 on an objective's lane, 1 beside; rest +8 there; ceiling 16 on RIDGE's lane, else 24). While it pushes: w 3, rest
 * +16, ceiling 40 on the assaulted lane (RIDGE included); w >= 2 and ceiling 32 beside it. While it consolidates: rest
 * +16 on the lane, the rest as §4.11.
 */
export function laneTerms(s, base, side, slot) {
  let weight = objectiveWeight(s, base, slot);
  let rest = weight === 2 ? OBJECTIVE_REST : 0;
  let ceiling = goalOf(s, base, slot);
  // THE TREND (§4.14): its side w + 1 and rest + 8 on every lane, ceiling + 8 x strength; the other side rest - 8 and
  // ceiling - 8 x strength (the objective's +8 and a -8 cancel to 0).
  const t = trendFor(s, base, side), strength = trendStrength(s, base);
  if (t !== 0) {
    if (t > 0) weight++;
    rest = (rest + Math.imul(t, PUSH_STEP)) | 0;
    ceiling = (ceiling + Math.imul(Math.imul(t, PUSH_STEP), strength)) | 0;
    if (ceiling < PUSH_MIN) ceiling = PUSH_MIN;
  }
  const phase = assaultPhase(s, base, side);
  if (phase !== ASSAULT_IDLE) {
    const d = slot - objectiveLane(s, base, assaultTarget(s, base, side));
    if (phase === ASSAULT_PUSH) {
      if (d === 0) { weight = t > 0 ? 4 : 3; rest = ASSAULT_REST; if (ceiling < ASSAULT_CEILING) ceiling = ASSAULT_CEILING; }
      else if (d === 1 || d === -1) { if (weight < 2) weight = 2; if (ceiling < ASSAULT_CEILING_BESIDE) ceiling = ASSAULT_CEILING_BESIDE; }
    } else if (d === 0) rest = ASSAULT_REST;
  }
  return { weight, rest, ceiling };
}

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
  s[base + TAC_VERDICT + w] = VERDICT_NONE;         // §4.10: a respawn clears the team's verdict
  enterInLane(s, base, index);
}

/**
 * ON POST (§4.3, §4.10, re-ruled 2026-09-16 20:30): the tank stands within 1.5 m of its hold - its slot x and its line,
 * the hull-down pick for an overwatch tank. `seamAt(x)` is the front's z at x, `ground(x, z)` the surface.
 */
export function onPost(s, base, index, tick, seamAt, ground) {
  const p = postOf(s, base, index, tick), side = teamOf(index).side;
  const line = add(seamAt(p.x) | 0, mulFast(Math.imul(side, ONE), p.depth));
  const hold = p.bounding ? line : hullDownHold(line, side, p.x, ground);
  const b = O_UNITS + Math.imul(index, U_WORDS);
  const dx = sub(s[b], p.x), dz = sub(s[b + 1], hold);
  if (abs(dx) > ON_POST || abs(dz) > ON_POST) return false;
  return add(mulFast(dx, dx), mulFast(dz, dz)) <= mulFast(ON_POST, ON_POST);
}

/**
 * THE POST IS HELD UNTIL THE BOUND ARRIVES (§2.6 with §0 "Hold is the default"): at a leg boundary of a pair with both
 * alive, if either tank is not yet on post under the roles of the leg that is ending, the team's role clock starts one
 * tick later - the swap waits for the bound to finish, and no post moves under a tank still walking to it. Measured at
 * 1830888 (tools/measure-hold.mjs): of 36 legs whose bounding tank never reached its post, 24 ended with it travelling
 * and 8 opened on a tank still walking in.
 */
export function holdLegs(s, base, tick, seamAt, ground) {
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) {
    const side = w < TEAMS_PER_SIDE ? -1 : 1, team = mod(w, TEAMS_PER_SIDE), k0 = Math.imul(team, 2);
    const i0 = (k0 << 3) | (side < 0 ? 0 : 4), i1 = ((k0 + 1) << 3) | (side < 0 ? 0 : 4);
    if (!aliveAt(s, i0) || !aliveAt(s, i1)) continue;
    const { period } = schedule(s[base + TAC_SEED], side, team);
    const start = s[base + TAC_ROLE_START + w];
    const now = idiv((tick | 0) - start, period) & 1, before = idiv(((tick | 0) - 1 - start) | 0, period) & 1;
    if (now !== before && !teamOnPost(s, base, side, team, ((tick | 0) - 1) | 0, seamAt, ground)) s[base + TAC_ROLE_START + w] = (start + 1) | 0;
  }
}

/** Both living tanks of the tank's team stand on post (a dead one does not hold the team back). */
function teamOnPost(s, base, side, team, tick, seamAt, ground) {
  const k0 = Math.imul(team, 2);
  for (let m = 0; m < 2; m++) {
    const idx = ((k0 + m) << 3) | (side < 0 ? 0 : 4);
    if (aliveAt(s, idx) && !onPost(s, base, idx, tick, seamAt, ground)) return false;
  }
  return true;
}

/**
 * After a team fired (§4): to the free slot beside it, left or right hashed from (seed, side, team, tick), at most
 * once per SCOOT_TICKS. Beside it, not the next in the side's permutation: measured, that was a median 66 m (p90
 * 132 m) across the field, and the pair drove through the other teams - 92.8% of the ticks where the separation
 * push undid a tank's own step.
 */
export function scoot(s, base, index, tick, seamAt, ground) {
  const { side, team } = teamOf(index);
  const w = teamWord(side, team);
  if ((tick | 0) - s[base + TAC_SCOOT + w] < SCOOT_TICKS) return false;
  // ONLY FROM POST (re-ruled 20:30): a shot from a team still in a swap or a push does not scoot it and spends no
  // cool-down; the next shot may.
  if (!teamOnPost(s, base, side, team, tick, seamAt, ground)) return false;
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
      const cap = laneTerms(s, base, side, next).ceiling;
      if (s[base + TAC_PUSH + w] > cap) s[base + TAC_PUSH + w] = cap;   // onto the crest, or out of the assault lanes
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
export function pressure(s, base, tick, seamAt, ground) {
  assaultClock(s, base, tick);                    // §4.12: "written by the assault clock at the top of pressure"
  const hash = s[base + TAC_SEED];
  const reach = Math.imul(GUN_M, 256);
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) {
    const side = w < TEAMS_PER_SIDE ? -1 : 1, team = mod(w, TEAMS_PER_SIDE);
    if (mod((tick | 0) + mod(mix(hash, 300 + w) >>> 1, PUSH_TICKS), PUSH_TICKS) !== 0) continue;
    // (a) A PUSH COMPLETES BEFORE THE NEXT IS READ (re-ruled 20:30): no re-read while a living tank of the team is off post.
    if (!teamOnPost(s, base, side, team, tick, seamAt, ground)) continue;
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
    const slot = s[base + TAC_SLOT + w], terms = laneTerms(s, base, side, slot), weight = terms.weight;
    // A widow never pushes (§4.10): it drifts to 0 - or, on the side a trend runs against, back to that side's -8 (§4.14
    // "the bears are pushed back": giving ground is not a push). Drifting widows to 0 held the pushed-back side's widows
    // at 0 on 49 of its re-reads in the up-trend probe (seeds 1-5, from tick 1200).
    const rest = widow ? (terms.rest < 0 ? terms.rest : 0) : terms.rest;
    const verdict = !widow && own + weight >= foe + PUSH_TAKE_LEAD ? VERDICT_TAKE
      : !widow && foe >= own + PUSH_GIVE_LEAD + weight ? VERDICT_GIVE : VERDICT_DRIFT;
    // (b) A CONFIRMED VERDICT (re-ruled 20:30): a step only when this reading agrees with the last one, so a new
    // direction needs two readings and 0 -> 8 -> 0 inside ten seconds cannot happen; a continued direction steps at once.
    const confirmed = s[base + TAC_VERDICT + w] === verdict;
    s[base + TAC_VERDICT + w] = verdict;
    if (!confirmed) continue;
    if (verdict === VERDICT_TAKE) push = Math.min(terms.ceiling, push + PUSH_STEP);
    else if (verdict === VERDICT_GIVE) push = Math.max(PUSH_MIN, push - PUSH_STEP);
    else push = push > rest ? push - PUSH_STEP : push < rest ? push + PUSH_STEP : rest;
    if (push > terms.ceiling) push = terms.ceiling;
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
