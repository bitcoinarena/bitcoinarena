// WHY A COVER CLAIM DIES, and whether the chart's scroll is what kills it (the owner 2026-09-19, ruling (b)).
//
// A candle-lip place id is `CRATER_PLACE_MAX + c` where c is the chart SLOT, not the candle body. The layout is
// rebuilt from the tape every tick, so if the tape moves, slot c holds a different body and the man's claim silently
// becomes a different walk. This proves or kills that, on the §11.3 test's own drive (seeds 1 and 2, 900 ticks of
// warm-up, then 2400 with a nuke every 30 s), and prints what else claims die of.
//
// The cause is read from the state at the tick the claim drops, in §11.3's own order:
//   PLACE GONE   coverPlace returns null - a wreck's id respawned, a crater expired, a body has no length
//   BODY MOVED   the place the id names is more than 1 m from where it was last tick: the slot took a new body
//   CLAMP        the place fell outside [seam - side x 40, seam + side x 8] because the seam moved
//   TANK         a living tank came inside 3 m of it (§8.3)
//   DIED         the man
//
//   node packages/nextblock/tools/measure-cover-claim-death.mjs
import { init, step, submitLiquidation, frontAt } from '../src/sim.js';
import { riflePost, RIFLE_STANDOFF } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536, isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const WRECK_MAX = L.UNITS * 2, CRATER_MAX = WRECK_MAX + L.MAX_CRATERS * 4;
const kindOf = (id) => (id < WRECK_MAX ? 'wreck' : id < CRATER_MAX ? 'crater' : 'lip');
const KINDS = ['wreck', 'crater', 'lip'];
const CAUSES = ['place gone', 'body moved', 'clamp', 'tank', 'died', 'other'];
const SQUADS_PER_SIDE = (L.SQUAD_WORDS / 2) | 0;
const squadWord = (side, k) => L.O_SQUADS + (side < 0 ? k : SQUADS_PER_SIDE + k);

const deaths = {}, lives = {}, sameId8 = {}, moved8 = {}, n8 = {}, leftAtDeath = {}, closed = {};
for (const k of KINDS) { deaths[k] = {}; for (const c of CAUSES) deaths[k][c] = 0; lives[k] = []; sameId8[k] = 0; moved8[k] = []; n8[k] = 0; leftAtDeath[k] = []; closed[k] = []; }
// WHAT THE CANDIDATE RULE WOULD MOVE (the owner 2026-09-19): "a held claim lasts until he arrives or the place is
// gone, still keyed from the post". That spares exactly the claims the CLAMP and a passing TANK end today, so this
// records, for those, how far the man still had to walk and how fast he was closing - the two numbers that say
// whether more time would have put him in the hole or only kept him walking.
const GAIT = 182714 / 65536;                          // army.js RIFLE_WALK, 2.788 m/s
const clampOver = [], clampFront = [], seamDrift = [], clampLeft = [];
let ticks = 0, tickOn = 0, heldTicks = 0, onTicks = 0;
let shiftLo = Infinity, shiftHi = -Infinity, samplesSeen = new Set();

for (const seed of [1, 2]) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  const open = new Map();                       // i -> { id, at, px, pz, lastX, lastZ }
  for (let t = 0; t < 2400; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    step(st, Q, 0, 0, 0, 0);
    ticks++;
    shiftLo = Math.min(shiftLo, st.candleShift | 0); shiftHi = Math.max(shiftHi, st.candleShift | 0);
    samplesSeen.add(s[L.O_TACTICS + T.TAC_MARKET + T.MK_SAMPLES]);
    const layout = st.candles && !st.noCandleField ? st.candles : null;
    const shift = st.candleShift | 0;
    let any = false;
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      const alive = s[b + L.U_STATE] !== 0 && s[b + L.U_HP] > 0;
      const id = alive ? T.coverClaim(s, L.O_TACTICS, i) : T.COVER_NONE;
      const was = open.get(i);
      if (was && was.id !== id) {
        // it ended this tick: name the cause from the OLD place, in §11.3's order
        const k = kindOf(was.id);
        lives[k].push((t - was.at) / 60);
        let cause = 'other';
        const side = s[b + L.U_SIDE] < 0 ? -1 : 1;
        const p = coverPlaceOf(s, was.id, side, layout, shift);
        if (!alive) cause = 'died';
        else if (!p) cause = 'place gone';
        else if (Math.hypot((p.x - was.lastX) / Q, (p.z - was.lastZ) / Q) > 1) cause = 'body moved';
        else {
          const px = riflePost(s[squadWord(s[b + L.U_SIDE], s[b + L.U_TARGET])], i);
          const seam = frontAt(st, px) | 0;
          const depth = Math.imul((p.z - seam) | 0, side) / Q;
          if (depth > 8 || depth < -40) {
            cause = 'clamp';
            // WHICH BOUND, BY HOW MUCH, AND WHAT MOVED. A lip place is static on this drive (measured: 0.00 m over
            // eight seconds), so an overshoot is the SEAM walking out from under a hole the man is still walking to.
            clampOver.push(depth > 8 ? depth - 8 : -40 - depth);
            clampFront.push(depth > 8 ? 1 : 0);
            seamDrift.push(Math.abs((seam - was.seam0) | 0) / Q);
            clampLeft.push(Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q));
          }
          else {
            for (let j = 0; j < L.UNITS; j += 4) {
              const tb = L.O_UNITS + j * L.U_WORDS;
              if (s[tb + L.U_STATE] === 0) continue;
              if (Math.hypot((p.x - s[tb]) / Q, (p.z - s[tb + 1]) / Q) < 3) { cause = 'tank'; break; }
            }
          }
        }
        deaths[k][cause]++;
        if ((cause === 'clamp' || cause === 'tank') && p) {
          const left = Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q);
          leftAtDeath[k].push(left);
          const secs = (t - was.at) / 60;
          if (secs > 0.5) closed[k].push((was.d0 - left) / secs);   // m/s closed over the claim's life
        }
        open.delete(i);
      }
      if (!alive || id === T.COVER_NONE) { open.delete(i); continue; }
      const side = s[b + L.U_SIDE] < 0 ? -1 : 1;
      const p = coverPlaceOf(s, id, side, layout, shift);
      if (!p) continue;
      heldTicks++;
      const d = Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q);
      if (d <= 0.5) { onTicks++; any = true; }
      let e = open.get(i);
      if (!e) { e = { id, at: t, px: p.x, pz: p.z, lastX: p.x, lastZ: p.z, checked: false, d0: d,
                      seam0: frontAt(st, riflePost(s[squadWord(s[b + L.U_SIDE], s[b + L.U_TARGET])], i)) | 0 }; open.set(i, e); }
      e.lastX = p.x; e.lastZ = p.z;
      // the id and the place eight seconds after it was taken
      if (!e.checked && t - e.at >= 480) {
        e.checked = true; const k = kindOf(e.id);
        n8[k]++; sameId8[k]++;                                   // it is still the same id: the claim survived
        moved8[k].push(Math.hypot((p.x - e.px) / Q, (p.z - e.pz) / Q));
      }
    }
    if (any) tickOn++;
  }
}

function coverPlaceOf(s, id, side, layout, shift) { return T.coverPlace(s, id, side, layout, shift); }

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const p90 = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * 0.9)] : 0; };
console.log(`THE CHART ON THIS DRIVE: candleShift ${shiftLo} .. ${shiftHi} (Q16.16), sample counts seen ${[...samplesSeen].join(',')}`);
console.log(`  A tape that never moves cannot reassign a slot. This is the drive the §11.3 assert runs on.\n`);
console.log(`OCCUPANCY ${tickOn} of ${ticks} ticks (${pc(tickOn, ticks)});  claim man-ticks reached ${onTicks} of ${heldTicks} (${pc(onTicks, heldTicks)})\n`);
console.log('WHAT A CLAIM DIES OF');
console.log(`   kind     ${CAUSES.map((c) => c.padStart(11)).join('')}      claims   a life`);
for (const k of KINDS) {
  const row = CAUSES.map((c) => String(deaths[k][c]).padStart(11)).join('');
  console.log(`   ${k.padEnd(8)}${row}${String(lives[k].length).padStart(12)}${mean(lives[k]).toFixed(1).padStart(9)} s`);
}
console.log('\nTHE CLAMP DEATHS IN DETAIL - the verdict at the step against the walk still left');
console.log(`   clamp deaths                 ${clampOver.length}`);
console.log(`   broke the FRONT bound (+8 m) ${clampFront.filter((x) => x).length}   the BACK bound (-40 m) ${clampFront.filter((x) => !x).length}`);
console.log(`   overshoot past the bound     mean ${mean(clampOver).toFixed(2)} m, p90 ${p90(clampOver).toFixed(2)} m`);
console.log(`   the seam moved since taking  mean ${mean(seamDrift).toFixed(2)} m, p90 ${p90(seamDrift).toFixed(2)} m`);
console.log(`   walk still left at the drop  mean ${mean(clampLeft).toFixed(1)} m = ${(mean(clampLeft) / GAIT).toFixed(1)} s at his gait`);
console.log('   The place does not move; the seam does. The hole is taken from under a man mid-walk.');

console.log('\nWHAT "A CLAIM LASTS UNTIL HE ARRIVES OR THE PLACE IS GONE" WOULD SPARE');
console.log('   kind     claims spared   of all   still to walk   at his gait   he was closing');
for (const k of KINDS) {
  const sp = deaths[k].clamp + deaths[k].tank, all = KINDS.reduce((a, x) => a, 0) || 1;
  const tot = CAUSES.reduce((a, c) => a + deaths[k][c], 0);
  const left = mean(leftAtDeath[k]), rate = mean(closed[k]);
  console.log(`   ${k.padEnd(8)}${String(sp).padStart(14)}${pc(sp, tot).padStart(9)}${left.toFixed(1).padStart(16)} m${(left / GAIT).toFixed(1).padStart(14)} s${rate.toFixed(2).padStart(16)} m/s`);
}
console.log(`   His gait is ${GAIT.toFixed(2)} m/s, so the walk left at the moment the clamp takes the hole is the seconds above.`);

console.log('\nTHE ID AND THE PLACE EIGHT SECONDS AFTER THE CLAIM WAS TAKEN');
console.log('   kind     claims that lived 8 s   same id   the place moved');
for (const k of KINDS)
  console.log(`   ${k.padEnd(8)}${String(n8[k]).padStart(22)}${String(sameId8[k]).padStart(10)}${mean(moved8[k]).toFixed(2).padStart(18)} m`);
