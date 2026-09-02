// The core's infantry line, laid beside test/vectors/csharp-infantry.json.
//
// Written for item (h). The armour has been measured against a recording for
// weeks; the riflemen - 72 of the 96 units a side - never were, because
// csharp-army.json carries only their count, mean z and spread, and
// replacement holds the count at 34-36 of 36 whatever happens to them.
//
// The three quantities that say whether this is the same line:
//
//   nearestPair    the closest any two opposing riflemen come. The C# lines
//                  interpenetrate and come within 4.7 m; a core that backs a
//                  man off inside 24 m answers 24.0 at every sample, and no
//                  16 m blast can then catch men from both sides.
//   inRifleRange   how many men have an enemy inside 26 m - the infantry's
//                  version of the armour's shooter count.
//   rifleKills     deaths that no blast can account for. Attributed the way
//                  measure-air.js does it: a detonation is a bomb slot that
//                  was live and is now free, and a corpse inside the radius
//                  belongs to it. Everything left over was shot.
//
//     node tools/measure-infantry.js [seed ...] [--seam0] [--core=DIR]
//
// --seam0 pins the frontline at z=0, which is the recording's condition.
// --core=DIR loads the core from elsewhere - a worktree from before a change
// is the before half of a before-and-after.
//
// Prints; asserts nothing.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const CORE = (args.find((a) => a.startsWith('--core=')) || '--core=../src').slice(7);
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(20260901, 20260902, 20260903, 20260904);

const base = new URL(CORE + '/', import.meta.url);
const { init, step, UNITS } = await import(new URL('sim.js', base).pathname);
const L = await import(new URL('state.js', base).pathname);
const HAS_AIR = typeof L.O_HELIS === 'number';
const air = HAS_AIR ? await import(new URL('rules/air.js', base).pathname) : null;

const Q = 65536;
const q = (v) => v / Q;
const isArmour = (i) => (i & 3) === 0;
const RADIUS = HAS_AIR ? q(air.BOMB_RADIUS) : 16;
const RIFLE_RANGE = 26;

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));
const REF = ref.passes.line.rows;

const dt = 1 / 60;
const TICKS = 90 * 60;
const SAMPLE = 5 * 60;

function pinSeam(st) { st.tape.fill(st.tape[0]); return st; }
const start = (seed) => (SEAM0 ? pinSeam(init(seed)) : init(seed));

function census(st) {
  const out = [];
  for (let i = 0; i < UNITS; i++) {
    const o = L.unitBase(i);
    out.push({
      i, armour: isArmour(i), side: st.i32[o + L.U_SIDE],
      alive: st.i32[o + L.U_STATE] !== 0 && st.i32[o + L.U_HP] > 0,
      x: q(st.i32[o + L.U_X]), z: q(st.i32[o + L.U_Z]), hp: q(st.i32[o + L.U_HP]),
    });
  }
  return out;
}

function bombSlots(st) {
  if (!HAS_AIR) return [];
  const out = [];
  for (let i = 0; i < L.MAX_BOMBS; i++) {
    const o = L.bombBase(i);
    out.push({ live: st.i32[o + L.B_STATE] !== 0,
               x: q(st.i32[o + L.B_X]), z: q(st.i32[o + L.B_Z]) });
  }
  return out;
}

/** Where each side's riflemen stand, and how close they get to each other. */
function line(now) {
  const men = now.filter((u) => u.alive && !u.armour);
  const bull = men.filter((u) => u.side < 0);
  const bear = men.filter((u) => u.side > 0);
  const stat = (g) => {
    if (g.length === 0) return { n: 0, z: 0, spread: 0 };
    const m = g.reduce((a, u) => a + u.z, 0) / g.length;
    const v = g.reduce((a, u) => a + (u.z - m) * (u.z - m), 0) / g.length;
    return { n: g.length, z: m, spread: Math.sqrt(v) };
  };

  let nearestPair = Infinity, sum = 0, counted = 0, inRange = 0;
  for (const a of men) {
    let best = Infinity;
    for (const b of men) {
      if (b.side === a.side) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < best) best = d;
    }
    if (best === Infinity) continue;
    if (best < nearestPair) nearestPair = best;
    if (best < RIFLE_RANGE) inRange++;
    sum += best; counted++;
  }
  return {
    bull: stat(bull), bear: stat(bear),
    nearestPair: counted ? nearestPair : 0,
    meanNearest: counted ? sum / counted : 0,
    inRifleRange: inRange,
  };
}

function measure(seed) {
  const st = start(seed);
  let prev = census(st);
  let prevBombs = bombSlots(st);
  let rifleKills = 0, bombKills = 0, arrived = 0;
  const rows = [];

  console.log(`INFCORE BEGIN  seed=${seed}${SEAM0 ? ' seam0' : ''} air=${HAS_AIR ? 'on' : 'off'}`);

  const sample = (t) => {
    const l = line(prev);
    const r = REF.find((x) => Math.abs(x.t - t) < 0.01);
    const refPart = r
      ? `  | REC bull ${r.bullInf.n}@${r.bullInf.z.toFixed(1)} bear ${r.bearInf.n}@${r.bearInf.z.toFixed(1)} ` +
        `nearest=${r.nearestPair.toFixed(1)} mean=${r.meanNearest.toFixed(1)} inRange=${r.inRifleRange} ` +
        `rifleKills=${r.rifleKills.bull + r.rifleKills.bear}`
      : '';
    console.log(`INFCORE t=${t.toFixed(0)} bull ${l.bull.n}@${l.bull.z.toFixed(1)}sd${l.bull.spread.toFixed(1)} ` +
                `bear ${l.bear.n}@${l.bear.z.toFixed(1)}sd${l.bear.spread.toFixed(1)} ` +
                `nearest=${l.nearestPair.toFixed(1)} mean=${l.meanNearest.toFixed(1)} ` +
                `inRange=${l.inRifleRange} rifleKills=${rifleKills} bombKills=${bombKills}` + refPart);
    rows.push({ t, ...l, rifleKills, bombKills });
  };
  sample(0);

  for (let f = 0; f < TICKS; f++) {
    step(st, 0, 0, 0, 0, 0);
    const now = census(st);
    const nowBombs = bombSlots(st);

    const landed = [];
    for (let i = 0; i < prevBombs.length; i++)
      if (prevBombs[i].live && !nowBombs[i].live) landed.push(nowBombs[i]);

    // A slot that died and was refilled inside one tick reads as a heal, which
    // is how reinforce shows from outside: it takes the first free slot, and
    // that can be the one that just emptied.
    const dead = [];
    for (let i = 0; i < UNITS; i++) {
      const a = prev[i], b = now[i];
      const healed = a.alive && b.alive && b.hp > a.hp;
      if ((!a.alive && b.alive) || healed) arrived++;
      if (!((a.alive && !b.alive) || healed)) continue;
      const at = healed ? a : b;
      dead.push({ armour: a.armour, x: at.x, z: at.z, claimed: false });
    }

    for (const bomb of landed)
      for (const d of dead)
        if (Math.hypot(d.x - bomb.x, d.z - bomb.z) <= RADIUS) d.claimed = true;

    for (const d of dead) {
      if (d.armour) continue;
      if (d.claimed) bombKills++; else rifleKills++;
    }

    prev = now; prevBombs = nowBombs;
    if ((f + 1) % SAMPLE === 0) sample((f + 1) * dt);
  }

  const inContact = rows.filter((r) => r.t >= 25);
  const span = (f) => [Math.min(...inContact.map(f)), Math.max(...inContact.map(f))];
  const [np0, np1] = span((r) => r.nearestPair);
  const [mn0, mn1] = span((r) => r.meanNearest);
  const [ir0, ir1] = span((r) => r.inRifleRange);
  console.log(`INFCORE summary seed=${seed} nearestPair=${np0.toFixed(1)}-${np1.toFixed(1)} ` +
              `meanNearest=${mn0.toFixed(1)}-${mn1.toFixed(1)} inRifleRange=${ir0}-${ir1} ` +
              `rifleKills=${rifleKills} bombKills=${bombKills}`);
  return { seed, np0, np1, mn0, mn1, ir0, ir1, rifleKills, bombKills };
}

const all = SEEDS.map(measure);
const e = ref.envelope;
const lo = (f) => Math.min(...all.map(f)), hi = (f) => Math.max(...all.map(f));
console.log('');
console.log('INFCORE ENVELOPE (the recording is air-off; bomb kills are the core\'s air)');
console.log(`INFCORE nearestPair   core ${lo((r) => r.np0).toFixed(1)}-${hi((r) => r.np1).toFixed(1)}` +
            `   REC ${e.nearestOpposingPair[0]}-${e.nearestOpposingPair[1]}`);
console.log(`INFCORE meanNearest   core ${lo((r) => r.mn0).toFixed(1)}-${hi((r) => r.mn1).toFixed(1)}` +
            `   REC ${e.meanNearestEnemy[0]}-${e.meanNearestEnemy[1]}`);
console.log(`INFCORE inRifleRange  core ${lo((r) => r.ir0)}-${hi((r) => r.ir1)}` +
            `   REC ${e.riflemenInRange[0]}-${e.riflemenInRange[1]}`);
console.log(`INFCORE rifleKills    core ${lo((r) => r.rifleKills)}-${hi((r) => r.rifleKills)}` +
            `   REC ${e.rifleKillsPerRound}`);
console.log(`INFCORE bombKills     core ${lo((r) => r.bombKills)}-${hi((r) => r.bombKills)}   REC (air off) -`);
