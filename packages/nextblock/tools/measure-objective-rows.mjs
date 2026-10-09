// WAR_TACTICS.md §0's rows for §4.11 OBJECTIVES, read from the state only (kanban #29), on a moving chart (one sample every
// 300 ticks, a whole-basis-point walk around the open hashed from (seed, sample)).
//
//     node tools/measure-objective-rows.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=3600]
//
//   An assault goes for something: of team-ticks with push >= 16 m, >= 60% are teams on an objective's own lane, and the mean
//     push of teams on objective lanes exceeds the mean push of all other teams by >= 6 m.
//   Every objective is fought over: on >= 60% of ticks each present objective has a living tank of EACH side inside 46 m of
//     its point (its lane's x, the seam there).
//   Objectives change hands: on >= 4 of 5 seeds at least one objective's holder goes from one side to the other.
//   (The client row - markers drawn at the core's points within 1 tick - is the client's; not read here.)
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number), TICKS = Number(arg('ticks', 3600));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step, submitSample, frontAt } = await import(url('sim.js'));
const L = await import(url('state.js')); const T = await import(url('rules/tactics.js'));
const ONE = 65536, REACH = 46 * ONE;
const mixh = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return h; };
const present = (s, o) => (T.objectivePresent ? T.objectivePresent(s, L.O_TACTICS, o) : true);
let over16 = 0, over16OnObj = 0, sumObj = 0, nObj = 0, sumOther = 0, nOther = 0, seedsFlipped = 0;
const fought = [0, 0, 0], presentTicks = [0, 0, 0]; const perSeed = [];
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32, open = s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN], bp = Math.max(1, Math.floor(open / 10000));
  let p = open, flipped = 0; const was = [0, 1, 2].map((o) => T.objectiveHolder(s, L.O_TACTICS, o));
  for (let t = 1; t <= TICKS; t++) {
    if (t % 300 === 0) { p += ((mixh(seed, t / 300) % 17) - 8) * bp; submitSample(st, p); }
    step(st, 0, 0, 0, ONE, 0);
    const lanes = [0, 1, 2].filter((o) => present(s, o)).map((o) => T.objectiveLane(s, L.O_TACTICS, o));
    for (let w = 0; w < 12; w++) {
      const slot = s[L.O_TACTICS + T.TAC_SLOT + w], push = s[L.O_TACTICS + T.TAC_PUSH + w], on = lanes.includes(slot);
      if (push >= 16 * ONE) { over16++; if (on) over16OnObj++; }
      if (on) { sumObj += push; nObj++; } else { sumOther += push; nOther++; }
    }
    for (let o = 0; o < 3; o++) {
      if (!present(s, o)) continue;
      presentTicks[o]++;
      const px = T.slotX(T.objectiveLane(s, L.O_TACTICS, o)), pz = frontAt(st, px);
      let bull = false, bear = false;
      for (let i = 0; i < 96; i += 4) {
        const b = L.O_UNITS + i * L.U_WORDS; if (s[b + L.U_STATE] === 0) continue;
        const dx = (s[b + L.U_X] - px) / ONE, dz = (s[b + L.U_Z] - pz) / ONE;
        if (dx * dx + dz * dz >= 46 * 46) continue;
        if (T.teamOf(i).side < 0) bull = true; else bear = true;
      }
      if (bull && bear) fought[o]++;
      const h = T.objectiveHolder(s, L.O_TACTICS, o);
      if (h !== was[o]) { if (was[o] !== T.HOLDER_NONE && h !== T.HOLDER_NONE) flipped++; was[o] = h; }
    }
  }
  if (flipped > 0) seedsFlipped++;
  perSeed.push(`seed ${seed}: holder flips side-to-side ${flipped}`);
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
console.log(perSeed.join('\n'));
console.log(`ROW goes-for-something: team-ticks push >= 16 m ${over16}, on an objective's lane ${over16OnObj} (${pct(over16OnObj, over16)}%, bar >= 60%); mean push on objective lanes ${(sumObj / nObj / ONE).toFixed(2)} m vs others ${(sumOther / nOther / ONE).toFixed(2)} m (diff ${((sumObj / nObj - sumOther / nOther) / ONE).toFixed(2)} m, bar >= 6)`);
console.log(`ROW fought-over: ticks with a living tank of each side inside 46 m: ${[0, 1, 2].map((o) => `objective ${o} ${pct(fought[o], presentTicks[o])}% of ${presentTicks[o]} present ticks`).join(', ')} (bar >= 60% each)`);
console.log(`ROW change-hands: seeds with a side-to-side flip ${seedsFlipped} of ${SEEDS.length} (bar >= 4 of 5)`);
