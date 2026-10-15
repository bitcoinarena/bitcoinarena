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
import { ONE, idiv, abs, add, sub, mulFast, sqrt, length2 } from '../fixed.js';
import { O_UNITS, U_WORDS, U_STATE, U_HP, UNITS, ARMOUR_MASK, MAX_CRATERS, craterBase, C_X, C_Z, C_R, C_ROUNDS } from '../state.js';
import { hullDownHold, crestRise, clearOfCraters } from './army.js';
import { CANDLES, CL_WORDS, CL_X, CL_Z0, CL_Z1, CANDLE_RAMP } from './candles.js';
import { MINER_DOOR_X } from './map.js';

/** The live craters as the army step sees them - the same flat list `stepUnit` is handed, built from the state. */
export function cratersOf(s) {
  const out = { n: 0, r: [] };
  for (let i = 0; i < MAX_CRATERS; i++) {
    const b = craterBase(i);
    if (s[b + C_R] <= 0 || s[b + C_ROUNDS] <= 0) continue;
    out.r.push(s[b + C_X], s[b + C_Z], s[b + C_R]);
    out.n++;
  }
  return out;
}

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
// [92 + k] armour tank k's held crest (§4.1 hysteresis): its offset from the post's line in Q16.16 metres; [116 + k] the
// post it was picked for (crestKey), or CREST_NONE.
export const TAC_CREST = 92, TAC_CREST_KEY = 116;

/**
 * §11.3 COVER: one word per rifle index, 72 of them, appended so no offset above moves.
 *
 * The word carries the claimed place in its LOW 16 bits, or `COVER_NONE` for a man in the open. The HIGH bits are
 * reserved for §11.4's posture (STAND / PRONE / COVER), which is not written by this letter: laying the word once
 * with the room already in it is what keeps the next letter from reshaping O_TACTICS and regenerating every golden
 * a second time.
 */
export const TAC_COVER = 140;
export const COVER_WORDS = 72;
export const COVER_NONE = 0xffff;
export const COVER_PLACE_MASK = 0xffff;
export const COVER_POSTURE_SHIFT = 16;            // §11.4's, reserved and unwritten here

/**
 * §11.5 SUPPRESSION - one word per fire team, nine a side, appended after §11.3's cover words so nothing above
 * moves. "+60 per round aimed at one of the team's living men (a rifle round, hit or miss; a coax burst, §4.4; a
 * suppressing round), -1 per tick, clamped [0, 600]. Integers, written on the shooter's tick, read at the top of
 * the next."
 *
 *   under fire   TAC_SUPP > 0        a round in the last second or so, decaying
 *   pinned       TAC_SUPP >= 120     two rounds inside three seconds, or one heavy burst
 *
 * There is NOTHING TO PORT: `Army.cs` has no suppression, no pinning, no morale and no cower - zero occurrences of
 * any of them. This is a declared GAP and the numbers below are this section's own.
 */
export const TAC_SUPP = 212;
export const SUPP_WORDS = 18;
export const SUPP_ROUND = 60, SUPP_MAX = 600, SUPP_PINNED = 120;
export const SUPP_BOMB = 300;                      // §12.3's blast: after a bomb, everybody is down
/** §11.5's own reach at an enemy MAN a rifleman cannot properly target. NOT `Army.cs`'s `CourierRange = 34f`,
 *  which is the range at which a rifleman engages the TRUCK - a different quantity that happens to share a digit.
 *  §8.1's 26 m rifle range is the one that genuinely agrees, and it stays where it is. */
export const SUPPRESS_REACH = Math.imul(34, ONE);
/** §11.5: a shell landing inside 8 m of a man adds 60 to his team. This core's own number, in metres. */
export const SHELL_PIN_REACH = Math.imul(8, ONE);
/** A pinned man crawls at 0.5 m/s. The gait lives with the other gaits in army.js (RIFLE_CRAWL) because this
 *  module imports that one, not the other way round. §11.4's step probe is 0.01 m and a crawl step is 0.0083 m, so
 *  a pinned man is never STAND by the number the core already has - there is no second crawl path. */

export const suppWord = (base, side, team) => (base + TAC_SUPP + (side < 0 ? team : FIRE_TEAMS_PER_SIDE + team)) | 0;
export const suppOf = (s, base, side, team) => s[suppWord(base, side, team)];
export const isPinned = (s, base, side, team) => s[suppWord(base, side, team)] >= SUPP_PINNED;
export const isUnderFire = (s, base, side, team) => s[suppWord(base, side, team)] > 0;
/** A round lands on the team of the man it was aimed at. Clamped at 600 so a firefight cannot bank suppression. */
export function addSupp(s, base, side, team, amount) {
  const w = suppWord(base, side, team);
  const v = (s[w] + amount) | 0;
  s[w] = v > SUPP_MAX ? SUPP_MAX : v;
}
/** -1 a tick, read at the top of the next tick (§11.5). Never below zero. */
export function decaySupp(s, base) {
  for (let k = 0; k < SUPP_WORDS; k++) { const w = base + TAC_SUPP + k; if (s[w] > 0) s[w] = (s[w] - 1) | 0; }
}

export const TAC_WORDS = 230;
// [82] the round's open (§4.13 TAC_OPEN, in the tape's unit), [83] samples taken since init, [84] trend (+1 UP, -1 DOWN, 0
// SIDEWAYS), [85] its strength 0-3, [86] lead (+1 BULLS, -1 BEARS, 0 FLAT), [87] the lead's momentum 0-3 (§4.14).
export const MK_OPEN = 0, MK_SAMPLES = 1, MK_TREND = 2, MK_STRENGTH = 3, MK_LEAD = 4, MK_MOMENTUM = 5;
/** §4.15 movement: the tick of the last price sample, and the window's low and high the chart was drawn with before it. */
export const MK_SAMPLE_TICK = 6, MK_PREV_LO = 7, MK_PREV_HI = 8;
/** §4.15 glide: the sample that left the tape at the last sample, faded out at -x over the 300 ticks after it. */
export const MK_PREV_OLDEST = 9;
// [76 + 3 x sideIndex] (bull 0, bear 1) the side's ASSAULT (§4.12): target objective in bits 0-3, phase in 4-7, the count of
// assaults it has started from bit 8; [77 + ...] the phase's start tick; [78 + ...] the tick the next may start.
export const ASSAULT_IDLE = 0, ASSAULT_PUSH = 1, ASSAULT_CONSOLIDATE = 2;
const ASSAULT_FIRST = 1200, ASSAULT_GAP = 2700, ASSAULT_GAP_FAVOURED = 1800, ASSAULT_REARM = 1200;
const ASSAULT_TICKS = 1800, CONSOLIDATE_TICKS = 900;
const ASSAULT_REST = Math.imul(16, ONE), ASSAULT_CEILING = Math.imul(40, ONE), ASSAULT_CEILING_BESIDE = Math.imul(32, ONE);
export const VERDICT_NONE = 0, VERDICT_TAKE = 1, VERDICT_GIVE = 2, VERDICT_DRIFT = 3;
const ON_POST = (Math.imul(3, ONE) >> 1) | 0;     // §4.3, §4.10 within 1.5 m of its hold, hull-down pick included
export const OBJ_HIGH = 0, OBJ_LOW = 1, OBJ_OPEN = 2, OBJECTIVES = 3;
/** An objective's lane byte when it is absent (§4.11: OPEN while the window holds no crossing of the open). */
export const OBJ_ABSENT = 255;
export const HOLDER_NONE = 0, HOLDER_BULL = 1, HOLDER_BEAR = 2;
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
  for (let k = 0; k < ARMOUR_PER_BOTH_SIDES; k++) { s[base + TAC_CREST + k] = 0; s[base + TAC_CREST_KEY + k] = CREST_NONE; }
  for (let w = 0; w < Math.imul(2, TEAMS_PER_SIDE); w++) s[base + TAC_VERDICT + w] = VERDICT_NONE;
  for (let si = 0; si < 2; si++) {
    const a = base + TAC_ASSAULT + Math.imul(3, si);
    s[a] = 0; s[a + 1] = 0;
    s[a + 2] = ASSAULT_FIRST + mod(mix(mix(hash, si === 0 ? 601 : 607), 0) >>> 1, ASSAULT_FIRST);   // 20 to 40 s
  }
}

// =====================================================================================================================
// OBJECTIVES (WAR_TACTICS.md §4.11, re-ruled 2026-09-16 21:15: HIGH and LOW of the chart, and OPEN): the ground window's
// candle with the highest high, the one with the lowest low, and the newest one the chart crossed the round's open in -
// read from the tape, which every node replays, on the sample tick only (never between: an objective does not flicker
// inside a sample). Nothing here reads the relief, and nothing reads a truck (§1.2).
// =====================================================================================================================

/** The slot lane (0..SLOTS_PER_SIDE-1) a ground x falls in: the nearest slot's. */
export function slotOfX(x) {
  const lane = idiv(sub(x, FIRST_SLOT) + (SLOT_PITCH >> 1), SLOT_PITCH);
  return lane < 0 ? 0 : lane > SLOTS_PER_SIDE - 1 ? SLOTS_PER_SIDE - 1 : lane;
}

/**
 * Re-reads the three objectives from the ground window's candles (§4.11). `candles` is the window's whole candles on the
 * ground, oldest first, each `[k, high, low, x]`: the round candle index, its high and low, and its centre's ground x.
 * HIGH: the highest high, LOW: the lowest low, a tie to the older candle as chart.js's HIGH and LOW (a new, higher high
 * at the miner's end takes the name the tick its sample lands). OPEN: the newest candle whose low..high holds the open; absent (lane OBJ_ABSENT) when none.
 * Each word: the candle's slot lane in bits 0-7, the holder in 8-15 (kept - a name that moves to a new candle keeps its
 * holder until the next re-read), the candle index in 16-31, signed (the seeded window before the open has k < 0).
 */
export function readObjectives(s, base, candles) {
  const open = s[base + TAC_MARKET + MK_OPEN];
  let hi = -1, lo = -1, op = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (hi < 0 || c[1] > candles[hi][1]) hi = i;
    if (lo < 0 || c[2] < candles[lo][2]) lo = i;
    if (c[2] <= open && open <= c[1]) op = i;
  }
  const picks = [hi, lo, op];
  for (let o = 0; o < OBJECTIVES; o++) {
    const holder = (s[base + TAC_OBJ + o] >> 8) & 255, i = picks[o];
    s[base + TAC_OBJ + o] = i < 0 ? (OBJ_ABSENT | (holder << 8))
      : (slotOfX(candles[i][3]) | (holder << 8) | Math.imul(candles[i][0] & 0xFFFF, 0x10000));
  }
}

export const objectiveLane = (s, base, o) => s[base + TAC_OBJ + o] & 255;
export const objectiveHolder = (s, base, o) => (s[base + TAC_OBJ + o] >> 8) & 255;
/** The round candle index an objective sits on (§4.11), for the chart. */
export const objectiveCandle = (s, base, o) => s[base + TAC_OBJ + o] >> 16;     // signed: the seeded window's are < 0
/** Whether an objective is on the ground at all: OPEN is not while the window holds no crossing (§4.11). */
export const objectivePresent = (s, base, o) => objectiveLane(s, base, o) !== OBJ_ABSENT;

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
  let lo = tape[0], hi = tape[0];
  for (let k = 1; k < tape.length; k++) { lo = lo < tape[k] ? lo : tape[k]; hi = hi > tape[k] ? hi : tape[k]; }
  s[base + TAC_MARKET + MK_SAMPLE_TICK] = 0;
  s[base + TAC_MARKET + MK_PREV_LO] = lo;
  s[base + TAC_MARKET + MK_PREV_HI] = hi;
  s[base + TAC_MARKET + MK_PREV_OLDEST] = tape[0];
  readMarket(s, base, tape);
}

/**
 * A finished candle's colour (§4.14): +1 green, -1 red, 0 a doji.
 *
 * THE DOJI BAND IS 0.3 bp, NOT 3 (measured 2026-09-19 from the owner's 12:55 shot). §4.14 writes both numbers and they
 * are not the same one: *"a candle whose body is under 3 bp of the open (a doji, $2.25 at $75,000)"* - but 3 bp of
 * $75,000 is $22.50, and $2.25 is 0.3 bp. The worked example is the intent; the prose slipped a decimal and the core
 * had copied the prose.
 *
 * What the wrong band did on the ground: at $81,300 a candle stayed a doji unless its body cleared $24.30, while the
 * HUD's whole visible price range in that shot was about $50. So a chart climbing a third of its own height read six
 * doji, net 0, SIDEWAYS. Measured live on the Daily, the six bodies were 2.47, 0.49, 0.24, 0.00, 0.25 and 0.68 bp -
 * every one under 3, so the core said SIDEWAYS while the player watched candles climb from LOW into GATE. At 0.3 bp
 * the same six read green, green, doji, doji, doji, green: net 3, UP strength 1, which is what the ground shows.
 * No other §4.14 number moves - not the |net| < 2 sideways band, not the 2-3 / 4-5 / 6 strengths.
 */
export function candleColour(open, close) {
  const doji = idiv(Math.imul(abs(open), 3), 100000);   // 0.3 bp of the open: $2.25 at $75,000, §4.14's own example
  return close - open > doji ? 1 : open - close > doji ? -1 : 0;
}

/**
 * THE COLOUR OF THE `c`th FINISHED CANDLE BACK, `c` = 0 the newest, counted from the tape index `end` that the newest
 * finished candle closes on (`trendEnd` below).
 *
 * IT IS THE BODY THE PLAYER SEES, and until 2026-09-19 21:39 it was half of it (the owner,
 * hud-sideways-five-red-2139.png: "SIDEWAYS is wrong - last five candles are RED"). A candle is TWO samples: §4.15's
 * staircase opens each one on the previous candle's close (chart.js: `o = sample[a - 1]`, `c = sample[a + 1]`), and
 * the world's bodies are built the same way (candles.js `candleLayout`). This read `tape[end - 2c - 1]` as the open -
 * the sample in the MIDDLE of the candle, the one that draws its wick - so it graded the second half of each body and
 * threw the first half away. Every body it scored was half the body on the screen.
 *
 * Measured (tools/measure-trend-vs-chart.mjs): a chart falling $5.20 a candle at $81,339 draws six red bodies and
 * scored six bodies of $2.60. The doji band is $2.44, so a drawn body anywhere in ($2.44, $4.88] was RED on the
 * screen and a DOJI to the trend - a factor of two wide, and the shot sits in it: five red candles, net 0, SIDEWAYS,
 * and six dots that do not match the candles above them.
 *
 * The band is not what was wrong and does not move. One function now, used by the trend and by the HUD's six dots
 * (chart.js), so the two cannot drift apart again.
 */
export function trendCandle(tape, end, c) {
  const close = end - Math.imul(c, 2);
  return candleColour(tape[close - 2], tape[close]);
}

/** The tape index the newest FINISHED candle closes on: the newest sample on an even count, one earlier on an odd one
 * (that one is still forming, §4.15's shift). */
export const trendEnd = (tape, count) => (tape.length - 1 - (count & 1)) | 0;

/**
 * Re-read lead and trend from the tape (§4.14). Six finished candles, newest first, each the body §4.15 draws.
 * Green: close over open by more than the doji band; red: under by more than it; else a doji, neither.
 */
export function readMarket(s, base, tape) {
  const count = s[base + TAC_MARKET + MK_SAMPLES];
  const last = tape.length - 1, end = trendEnd(tape, count);
  let net = 0;
  for (let c = 0; c < 6; c++) net += trendCandle(tape, end, c);
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
    if (!objectivePresent(s, base, o)) continue;
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
      for (let o = 0; o < OBJECTIVES; o++) if (objectivePresent(s, base, o) && objectiveHolder(s, base, o) !== mine) unheld++;
      if (unheld === 0) { s[a + 2] = ((tick | 0) + ASSAULT_REARM) | 0; continue; }          // holds all three: defends
      let pick = mod(mix(mix(mix(hash, si === 0 ? 613 : 617), n), 1) >>> 1, unheld), chosen = 0;
      for (let o = 0; o < OBJECTIVES; o++) {
        if (!objectivePresent(s, base, o) || objectiveHolder(s, base, o) === mine) continue;
        if (pick === 0) { chosen = o; break; }
        pick--;
      }
      s[a] = chosen | (ASSAULT_PUSH << 4) | Math.imul(n + 1, 256);
      s[a + 1] = tick | 0;
    } else if (phase === ASSAULT_PUSH) {
      if (objectivePresent(s, base, target) && objectiveHolder(s, base, target) === mine) { // success
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
 * (w 2 on an objective's lane, 1 beside; rest +8 there; ceiling 24 everywhere). While it pushes: w 3, rest
 * +16, ceiling 40 on the assaulted lane; w >= 2 and ceiling 32 beside it. While it consolidates: rest
 * +16 on the lane, the rest as §4.11.
 */
export function laneTerms(s, base, side, slot) {
  let weight = objectiveWeight(s, base, slot);
  let rest = weight === 2 ? OBJECTIVE_REST : 0;
  let ceiling = PUSH_MAX;                         // §4.11: 24 everywhere - the old RIDGE cap is gone with RIDGE
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
    if (!objectivePresent(s, base, o)) continue;
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
    s[base + TAC_OBJ + o] = (s[base + TAC_OBJ + o] & ~0xFF00) | (holder << 8);
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

/**
 * NO TANK ON A LOADING DOCK (the owner 2026-09-19 13:09, playtest: "tanks must not drive on the Post Office loading
 * dock"). The post office stands at x -114.4 m and its paving reaches 31 m out, to -83.4 m; the outer slot is at
 * -81 m and the pair's outer tank sits 6 m beyond it, at -87 m, which is 3.6 m of concrete. The slot pitch does not
 * move - it is 27 m, pinned by the 46 m gun and the kill-zone row - and neither does the free slot or the pair's
 * 12 m: what moves is the outer tank's own post, pulled back to the kerb. The pair stands 9 m apart there instead
 * of 12, and both tanks still reach their posts, which a movement clamp alone would not have left true (a post
 * outside the clamp is a tank permanently off post, and a team off post never swaps roles or scoots).
 *
 * THE PAIR MOVES TOGETHER, which the first attempt did not: clamping each tank on its own left the outer pair 9 m
 * apart while the separation rule holds tanks 12 m apart, so both were pushed a metre and a half off their posts and
 * the team stopped scooting (measured: "seed 2 tick 1396: team 3 scooted with a tank off post"). The pair's CENTRE
 * is clamped, so the two stay 12 m apart and the outer one stands on the kerb.
 */
export const DOCK_X = 5465702;                    // 83.4 m: the post office's paving edge, west
const PAIR_WEST_X = (-DOCK_X + PAIR_HALF) | 0;    // -77.4 m: the westernmost pair centre
// EAST IS THE MINER'S DOOR, NOT THE SAME NUMBER (2026-09-19 15:58). While the world ended at 130 m the two kerbs
// were both 83.4 m and one constant did for both; with the miner moved east its drawn west edge is 108.4 m, the
// army's own edge (FRONT_X - 4 = 88 m) is the nearer limit there, and a symmetric clamp would hold the east flank
// 4.6 m short of where the doctrine puts it for no reason.
const PAIR_EAST_X = (Math.min(5767168, MINER_DOOR_X - Math.imul(4, ONE)) - PAIR_HALF) | 0;   // 88 m less the pair's 6 m

/* ------------------------------------------------------------------ §11.3 COVER: wrecks and craters ---------- */

/**
 * COVER IS A PLACE, AND A PLACE IS A FUNCTION OF THE STATE (WAR_TACTICS.md §11.3, the owner 2026-09-16 19:02:
 * "they must not stay cannon fodder. They take cover, go prone, suppress, use wrecks and craters. Real infantry
 * hides."). Nothing here is ported: the old army has no cover at all, and its one artefact in this ground -
 * `AvoidWrecks`, which pushes a man OUT of a crater - is the inverse of this rule and stays where it belongs, on
 * the armour. The core takes cover in its own units.
 *
 * Measured before any of it, on the tree deployed at 0.0.1739: a place stood free within 12 m of a man on 96.9% of
 * ticks and a man was on one on 1.0%, which is accident - there were no claims to make. Of 54 men killed by fire,
 * 21 had a place within 12 m when they died.
 *
 * A PLACE ID is one integer so the claim is one word: a wreck's two are `armour index x 2 + which`, 0..191, and a
 * crater's four are `192 + slot x 4 + corner`, 192..223. `COVER_NONE` is a man in the open.
 */
export const COVER_PLACES_WRECK = 2, COVER_PLACES_CRATER = 4;
const WRECK_PLACE_MAX = Math.imul(UNITS, COVER_PLACES_WRECK);          // ids below this are a wreck's
const CRATER_PLACE_MAX = WRECK_PLACE_MAX + Math.imul(MAX_CRATERS, COVER_PLACES_CRATER);   // then the craters'
const LIP_RAMP_OUT = add(CANDLE_RAMP, ONE >> 1);   // the foot of the ramp on his side, and 0.5 m out from it
const COVER_BEHIND = Math.imul(3, ONE) + 39322;   // 3.6 m: behind the hull, 0.6 m clear of its 3 m circle
const COVER_ASIDE = Math.imul(2, ONE);            // 2 m either side of the wreck's centre
const COVER_RIM_IN = ONE;                         // a crater's places sit 1 m inside its lip
export const COVER_REACH = Math.imul(12, ONE);    // eligible within 12 m of his POST
export const COVER_REACH_TREND = Math.imul(18, ONE);   // 18 m for the side the trend runs against (§4.14)
export const COVER_ON = 32768;                    // on it, within 0.5 m
const COVER_TANK_CLEAR = Math.imul(3, ONE);       // never a place inside 3 m of a LIVING tank (§8.3)
const CLAMP_BACK = Math.imul(40, ONE), CLAMP_FRONT = Math.imul(8, ONE);   // §12.1's leash on a man

// The four rim angles, Q16.16 sin and cos: -50, -20, +20, +50 degrees from the seam normal (§11.3's own list).
const RIM_SIN = [-50204, -22417, 22417, 50204];
const RIM_COS = [42126, 61584, 61584, 42126];

/** Where place `id` stands for a man of `side`, or null if that place does not exist in this state. */
export function coverPlace(s, id, side, layout = null, shift = 0) {
  if (id === COVER_NONE || id < 0) return null;
  if (id < WRECK_PLACE_MAX) {
    const unit = idiv(id, COVER_PLACES_WRECK), which = id - Math.imul(unit, COVER_PLACES_WRECK);
    if ((unit & ARMOUR_MASK) !== 0) return null;                        // men leave no wreck
    const b = O_UNITS + Math.imul(unit, U_WORDS);
    if (s[b + U_STATE] !== 0) return null;                              // a live hull is not a wreck
    return { x: add(s[b], which === 0 ? -COVER_ASIDE : COVER_ASIDE),
             z: add(s[b + 1], Math.imul(side, COVER_BEHIND)) };
  }
  if (id >= CRATER_PLACE_MAX) {
    // A CANDLE LIP (§11.3's third kind of place, §4.15's geometry). One place along the plateau edge that stands
    // between the man and the enemy, at the foot of the ramp on his side and half a metre out from it. A body is
    // 5.18 m across since ruling B's refit, so "one every 4 m along the edge" is one place, at the body's middle.
    // It scrolls with the chart: the layout's x is the unshifted slot and the world's is that less the shift.
    const c = id - CRATER_PLACE_MAX;
    if (!layout || c >= CANDLES) return null;
    const b = Math.imul(c, CL_WORDS);
    const z0 = layout[b + CL_Z0], z1 = layout[b + CL_Z1];
    if (sub(z1, z0) <= 0) return null;                                  // a body with no length has no edge
    const edge = side < 0 ? z0 : z1;
    return { x: sub(layout[b + CL_X], shift | 0), z: sub(edge, Math.imul(side, LIP_RAMP_OUT)) };
  }
  const k = id - WRECK_PLACE_MAX, slot = idiv(k, COVER_PLACES_CRATER), corner = k - Math.imul(slot, COVER_PLACES_CRATER);
  if (slot >= MAX_CRATERS) return null;
  const b = craterBase(slot);
  const r = s[b + C_R];
  if (r <= 0 || s[b + C_ROUNDS] <= 0) return null;
  const reach = sub(r, COVER_RIM_IN);
  return { x: add(s[b + C_X], mulFast(reach, RIM_SIN[corner])),
           z: add(s[b + C_Z], Math.imul(side, mulFast(reach, RIM_COS[corner]))) };
}

/** Every place id this state holds, in the order §11.3 breaks ties by: wrecks by index, then craters by slot. */
export function coverPlaceIds(s, layout = null) {
  const out = [];
  for (let i = 0; i < UNITS; i++) {
    if ((i & ARMOUR_MASK) !== 0) continue;
    const b = O_UNITS + Math.imul(i, U_WORDS);
    if (s[b + U_STATE] !== 0) continue;
    for (let w = 0; w < COVER_PLACES_WRECK; w++) out.push(Math.imul(i, COVER_PLACES_WRECK) + w);
  }
  for (let k = 0; k < MAX_CRATERS; k++) {
    const b = craterBase(k);
    if (s[b + C_R] <= 0 || s[b + C_ROUNDS] <= 0) continue;
    for (let c = 0; c < COVER_PLACES_CRATER; c++) out.push(WRECK_PLACE_MAX + Math.imul(k, COVER_PLACES_CRATER) + c);
  }
  if (layout) for (let c = 0; c < CANDLES; c++) {
    const b = Math.imul(c, CL_WORDS);
    if (sub(layout[b + CL_Z1], layout[b + CL_Z0]) > 0) out.push(CRATER_PLACE_MAX + c);
  }
  return out;
}

/** The word a rifle index's claim lives in: 72 of them, the armour indices skipped. */
export const coverWord = (base, index) => (base + TAC_COVER + (index - idiv(index, 4) - 1)) | 0;
export const coverClaim = (s, base, index) => s[coverWord(base, index)] & COVER_PLACE_MASK;

/**
 * §11.4 POSTURE, in the high bits §11.3 reserved. Three values, derived and never chosen:
 *
 *   STAND  his OWN step this tick was over 0.01 m (x + z) - a rush leg, a walk to his post or his place, a column
 *          walking in. A push is not a step: §8.3 stands a man 3 m off a hull after he has moved, and §3's
 *          replacement is a column; neither is his own gait, and counting them would have inflated STAND by 20189
 *          man-ticks on the line (measured).
 *   COVER  within 0.5 m of the place he claims (§11.3), not stepping.
 *   PRONE  everything else that did not step. "A halt is a firing halt, and it is fired from the ground."
 *
 * STAND is 0 so an unwritten word reads as the most exposed posture: a tick before the first write behaves exactly
 * as the core did before this letter, and no golden moves for a reason other than the rule.
 */
export const POSTURE_STAND = 0, POSTURE_PRONE = 1, POSTURE_COVER = 2;
const POSTURE_MASK = 3;
export const coverPosture = (s, base, index) => (s[coverWord(base, index)] >>> COVER_POSTURE_SHIFT) & POSTURE_MASK;

/**
 * Set the CLAIM without touching the posture bits above it. The claim pass runs at the top of the infantry step
 * and the posture pass at the end of the movement pass, with the rifle firing in between - so a claim written as
 * a whole word wiped §11.4's posture to STAND (0) for exactly the men who had just taken a hole, and the rifle
 * shot at them for the rest of that tick as if they were standing in the open. Measured as part of the 2.8% of
 * man-ticks where the written word disagreed with the rule's own derivation.
 */
export function setCoverClaim(s, base, index, place) {
  const w = coverWord(base, index);
  s[w] = ((s[w] & ~COVER_PLACE_MASK) | (place & COVER_PLACE_MASK)) | 0;
}
export function setCoverPosture(s, base, index, posture) {
  const w = coverWord(base, index);
  s[w] = ((s[w] & ~(POSTURE_MASK << COVER_POSTURE_SHIFT)) | ((posture & POSTURE_MASK) << COVER_POSTURE_SHIFT)) | 0;
}

/**
 * §11.4's worth: the rifle's threshold, and NOTHING about the draw. "The hit roll is one draw, `< 45` per mil; the
 * threshold is what changes, the draw count never does, so the stream keeps its shape." A posture that added or
 * skipped a draw would shift every golden and every replay.
 *
 * Half at a PRONE man and a quarter at a COVER man, as shifts of the value §4.14 has already adjusted - "posture
 * multiplies after". At §4.14-neutral that is exactly the section's own 45 / 22 / 11 per mil, in per mil, and not
 * a number carried over from C#, which has no posture at all and fires a flat 4.5% at everything.
 */
export function rifleHitAt(hit, posture) {
  if (posture === POSTURE_COVER) return hit >> 2;
  if (posture === POSTURE_PRONE) return hit >> 1;
  return hit;
}

/** §11.4: a bomb reaches a COVER man only inside 8 m; a PRONE or STAND man at the full 16 m as before. */
export const COVER_BOMB_REACH = Math.imul(8, ONE);

/**
 * Is `place` one this man may take? §11.3: within 12 m of his POST - 18 m for the side the trend runs against -
 * inside his clamp, and not inside 3 m of a living tank. His post, not his position, "so a man does not wander to
 * cover".
 */
export function coverEligible(s, base, side, postX, postZ, seamZ, place, held = false) {
  // A HELD PLACE IS NOT MEASURED FOR DISTANCE, because it IS his post: "it is his post while he holds the claim;
  // the line's post is where he stands when he has no hole". Measuring a held claim against the line's post is
  // what made claims flicker - measured, 132 taken and 123 dropped in a minute, a claim lasting 3.2 s, because a
  // place a hair over 12 m from a post that drifts with its squad falls in and out of reach every few seconds and
  // the man never arrives. The clamp and the living-tank rule still apply to it: those are about where the place
  // is, not how far he would have to walk.
  if (!held) {
    const reach = trendFor(s, base, side) < 0 ? COVER_REACH_TREND : COVER_REACH;
    const dx = sub(place.x, postX), dz = sub(place.z, postZ);
    if (abs(dx) > reach || abs(dz) > reach) return false;
    if (length2(dx, dz) > reach) return false;
  }
  // THE CLAMP PICKS A HOLE; IT DOES NOT TAKE ONE BACK (the owner 2026-09-19, on the measurement below). The clamp
  // `[seam - side x 40, seam + side x 8]` says which places a man may be SENT to. Applied again every tick to a
  // claim he already holds, it takes the hole away from under him while he is still walking to it - and it does so
  // by a hair. Measured on the §11.3 drive, two seeds: 106 clamp deaths, 105 of them breaking the FRONT bound, by
  // a mean of 0.08 m and a p90 of 0.13 m, after the seam had walked a mean 5.45 m. The place itself does not move
  // at all (0.00 m over eight seconds). At the moment the hole is taken he still has 35.3 m to cover - 12.6 s at
  // his own gait - so he never arrives, and 91 of 151 lip claims and 15 of 60 wreck claims end that way.
  //
  // So a HELD claim is not re-clamped: he is given the walk. Everything else about a held claim is unchanged - the
  // living-tank rule below still takes it (§0's fault list names "a man holds ... one inside 3 m of a living
  // tank"), and `coverPlace` returning null still ends it when the wreck respawns or the crater expires. A tank is
  // not here at all: §11.3 is the men's, and armour keeps its own push and clamp in army.js.
  const depth = Math.imul(sub(place.z, seamZ), side);                   // + is his own side of the seam
  if (!held && (depth > CLAMP_FRONT || depth < -CLAMP_BACK)) return false;
  for (let i = 0; i < UNITS; i++) {
    if ((i & ARMOUR_MASK) !== 0) continue;
    const b = O_UNITS + Math.imul(i, U_WORDS);
    if (s[b + U_STATE] === 0 || s[b + U_HP] <= 0) continue;
    const tx = sub(place.x, s[b]), tz = sub(place.z, s[b + 1]);
    if (abs(tx) > COVER_TANK_CLEAR || abs(tz) > COVER_TANK_CLEAR) continue;
    if (length2(tx, tz) < COVER_TANK_CLEAR) return false;
  }
  return true;
}

/**
 * THE CLAIM PASS (§11.3), once per tick at the top of the infantry step, after the armour's separation and before
 * any man moves. Deterministic and draw-free: the living men of a side are visited in the order of
 * `mix(seedHash, 600 + index)` ascending - a fixed order for the round, hashed from the seed and the unit id, "so
 * the same eight men do not always get the holes" - and each keeps the claim it has while that place is still
 * eligible and free, else takes the NEAREST free eligible place. Ties by the place's own order, which
 * `coverPlaceIds` already gives: wrecks by index, then craters by slot, then place number.
 *
 * `postOfMan(index)` hands in where his line would put him, because eligibility is measured from the POST and not
 * from where he is standing. A man with no place is in the open and his word is COVER_NONE.
 */
export function coverClaims(s, base, tick, postOfMan, seamAt, layout = null, shift = 0) {
  const hash = s[base + TAC_SEED];
  const ids = coverPlaceIds(s, layout);
  for (let si = 0; si < 2; si++) {
    const side = si === 0 ? -1 : 1;
    const order = [];
    for (let i = 0; i < UNITS; i++) {
      if ((i & ARMOUR_MASK) === 0) continue;                       // armour takes no cover: §11.3 is the men's
      const b = O_UNITS + Math.imul(i, U_WORDS);
      if (s[b + U_STATE] === 0 || s[b + U_HP] <= 0) { setCoverClaim(s, base, i, COVER_NONE); continue; }
      if ((s[b + 2] < 0 ? -1 : 1) !== side) continue;
      order.push({ i, key: mix(hash, 600 + i) >>> 1 });
    }
    order.sort((a, b2) => (a.key - b2.key) || (a.i - b2.i));

    const taken = new Set();
    for (const { i } of order) {                                    // a kept claim is not offered to anyone else
      const held = coverClaim(s, base, i);
      if (held === COVER_NONE) continue;
      const post = postOfMan(i);
      const place = coverPlace(s, held, side, layout, shift);
      if (place && coverEligible(s, base, side, post.x, post.z, seamAt(post.x) | 0, place, true)) taken.add(held);
      else setCoverClaim(s, base, i, COVER_NONE);
    }
    for (const { i } of order) {
      if (coverClaim(s, base, i) !== COVER_NONE) continue;           // keeps what it has
      const post = postOfMan(i);
      const seam = seamAt(post.x) | 0;
      let best = COVER_NONE, bestD = 0;
      for (const id of ids) {
        if (taken.has(id)) continue;
        const place = coverPlace(s, id, side, layout, shift);
        if (!place) continue;
        if (!coverEligible(s, base, side, post.x, post.z, seam, place)) continue;
        const d = length2(sub(place.x, post.x), sub(place.z, post.z));
        if (best === COVER_NONE || d < bestD) { best = id; bestD = d; }
      }
      if (best !== COVER_NONE) { taken.add(best); }
      setCoverClaim(s, base, i, best);
    }
  }
}

/** Where a man is going, if he holds a place: his claim is his post while he holds it (§11.3). */
export function coverPostOf(s, base, index, side, layout = null, shift = 0) {
  const id = coverClaim(s, base, index);
  if (id === COVER_NONE) return null;
  return coverPlace(s, id, side, layout, shift);
}

/** A pair member's x on a slot: the pair's centre held off the paving, the member 6 m either side of it. */
export const pairX = (slot, member) => {
  const raw = slotX(slot);
  const centre = raw < PAIR_WEST_X ? PAIR_WEST_X : raw > PAIR_EAST_X ? PAIR_EAST_X : raw;
  return (centre + (member === 0 ? -PAIR_HALF : PAIR_HALF)) | 0;
};

/** Where a tank goes this tick: its team's slot, its side of the pair, and its depth line. */
export function postOf(s, base, index, tick) {
  const { side, team, member } = teamOf(index);
  const x = pairX(s[base + TAC_SLOT + teamWord(side, team)], member);
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
  const held = p.bounding ? line : crestHold(s, base, index, p, line, side, ground);
  // THE SAME POINT THE STEP AIMS AT: a post inside a crater is on its rim (army.js clearOfCraters, the owner 15:57).
  // Read here too, or a tank standing correctly on a rim would be measured as off post and its team would stop
  // swapping roles and scooting.
  const clear = clearOfCraters(cratersOf(s), p.x, held, side);
  const hold = clear.z;
  const b = O_UNITS + Math.imul(index, U_WORDS);
  const dx = sub(s[b], clear.x), dz = sub(s[b + 1], hold);
  if (abs(dx) > ON_POST || abs(dz) > ON_POST) return false;
  return add(mulFast(dx, dx), mulFast(dz, dz)) <= mulFast(ON_POST, ON_POST);
}

/**
 * HULL-DOWN HYSTERESIS (WAR_TACTICS.md §4.1, RULED 2026-09-17). The crest search picks, among the five candidates 2 m apart
 * about the line, the one with the highest rise in front - and on a scrolling chart and a pancake of near-equal rises the
 * pick changed on centimetres: measured on seeds 1-5 x 3600 (live-style samples), 3089 crest changes on unchanged posts,
 * and 261 of the 400 fidgets of the §0 wiggle row were overwatch z reversals. So each overwatch tank HOLDS a crest: the
 * search runs every CREST_EVERY ticks (and at once for a new post), and keeps the held candidate unless another's rise
 * beats it by CREST_SWITCH. The held pick is an offset from the line, so between searches it moves with the line - the
 * seam as the chart scrolls - which is a creep, not a new post.
 */
export const CREST_EVERY = 60;
export const CREST_SWITCH = 19660;                  // 0.3 m
export const CREST_NONE = -2147483648;
const ARMOUR_PER_BOTH_SIDES = 24;
const HULL_STEP_M = Math.imul(2, ONE), HULL_SEARCH_N = 2;

/** Which post a held crest belongs to: the slot x, the depth and the role. */
const crestKey = (p) => (((p.x >> 4) ^ Math.imul(p.depth >> 4, 40503)) ^ (p.bounding ? 1 : 0)) | 0;

/**
 * The hold z of an overwatch tank on post `p`: the line plus the crest it holds when that crest was picked for this very
 * post, else the plain search (a question about another tick's post - holdLegs reads the last tick's). Reads only.
 */
export function crestHold(s, base, index, p, line, side, ground, wreckAt) {
  const k = index >> 2;
  if (s[base + TAC_CREST_KEY + k] === crestKey(p)) return add(line, s[base + TAC_CREST + k]);
  return hullDownHold(line, side, p.x, ground, wreckAt);
}

/** Once a tick, before anything reads a post: every overwatch tank's held crest, searched on its schedule. */
export function updateCrests(s, base, tick, seamAt, ground, wreckAt) {
  for (let i = 0; i < 96; i += 4) {
    if (!aliveAt(s, i)) continue;
    const p = postOf(s, base, i, tick);
    if (p.bounding) continue;
    const k = i >> 2, side = teamOf(i).side, key = crestKey(p);
    const line = add(seamAt(p.x) | 0, mulFast(Math.imul(side, ONE), p.depth));
    const fresh = s[base + TAC_CREST_KEY + k] !== key;
    if (!fresh && mod(tick | 0, CREST_EVERY) !== 0) continue;
    let bestOffset = 0, bestRise = -2147483647;
    for (let c = -HULL_SEARCH_N; c <= HULL_SEARCH_N; c++) {
      const off = Math.imul(c, HULL_STEP_M), rise = crestRise(add(line, off), side, p.x, ground, wreckAt);
      if (rise > bestRise) { bestRise = rise; bestOffset = off; }
    }
    if (fresh) { s[base + TAC_CREST + k] = bestOffset; s[base + TAC_CREST_KEY + k] = key; continue; }
    const heldRise = crestRise(add(line, s[base + TAC_CREST + k]), side, p.x, ground, wreckAt);
    if (sub(bestRise, heldRise) >= CREST_SWITCH) s[base + TAC_CREST + k] = bestOffset;
  }
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
