// (o) The truck's neighbourhood: why the recording has 17 tanks at the parked
// truck and the core has 2.
//
// READ-ONLY. Nothing here moves a rule; the air is held off from outside the
// rules the way `measure-courier.js` does it, because the recording's courier
// pass is air "none".
//
// Three questions in order, each one narrowing the last:
//
//   1. Is the core short of units at all?  Counted on the WHOLE MAP, by kind
//      and by side, against `ArmyReferenceTests.cs:268` - `Courier(sb,
//      "courier", 12, 36)`, i.e. 12 armour and 36 infantry per side.
//   2. If the totals match, where do the units stand?  A histogram, never a
//      mean: a mean hides a split distribution, which is the shape a fall-back
//      line makes.
//   3. Is one seed's neighbourhood even comparable?  Neither army walks
//      towards the truck - `Courier` appears only in the firing code at
//      `Army.cs:616` and `:721` - and both scatter three squad anchors a side
//      across the same interval, so a single seed's count is where its anchors
//      happened to fall. The envelope is the comparison.
import { init, step } from '../src/sim.js';
import { MAX_UNITS, unitBase, U_HP, U_SIDE, U_X, U_Z } from '../src/state.js';
import { frontlineZ } from '../src/rules/frontline.js';

const ONE = 65536;
const SEED = 20260901;             // the recording's own seed
const isArmour = (i) => (i & 3) === 0;   // `sim.js:70`, every fourth slot
const HALF = Math.imul(92, ONE);         // C# `Army.FrontX`

/** The recording, read off `test/vectors/csharp-army.json`'s courier pass. */
const REC = { 10: [8, 0], 30: [8, 21], 60: [14, 18], 90: [17, 27] };

/** The sortie clocks, pinned from outside the rules. The pass is air "none". */
const airOff = (st) => {
  for (const k of ['heliClock', 'sortieClock']) if (k in st) st[k] = 1 << 30;
};

const run = (seed, marks, at) => {
  const st = init(seed);
  for (let s = 1; s <= 60 * 90; s++) {
    step(st, 0, 0, 0, 0, 0);
    airOff(st);
    // Tick 1 is a mark in its own right: the establishment question is about
    // the spawn, and by t = 5 s the first losses have already been taken.
    if (s === 1 && marks.includes(0)) at(0, st);
    else if (s % 60 === 0 && marks.includes(s / 60)) at(s / 60, st);
  }
};

const live = (st, want) => {
  const out = [];
  for (let i = 0; i < MAX_UNITS; i++) {
    const b = unitBase(i);
    if (st.i32[b + U_HP] <= 0) continue;
    if (want !== null && isArmour(i) !== want) continue;
    out.push({ i, x: st.i32[b + U_X], z: st.i32[b + U_Z], side: st.i32[b + U_SIDE] });
  }
  return out;
};

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
const f = (v, w = 6) => v.toFixed(1).padStart(w);

console.log('PRESENCE  truck parked at (0, 0), air off, seed 20260901 unless said');
console.log('');
console.log('1. THE WHOLE MAP, not the neighbourhood');
console.log('   t     armour bull/bear    infantry bull/bear    alive');
run(SEED, [0, 5, 30, 60, 90], (t, st) => {
  let ab = 0, ar = 0, ib = 0, ir = 0;
  for (const u of live(st, null)) {
    const armour = isArmour(u.i);
    if (armour) u.side < 0 ? ab++ : ar++; else u.side < 0 ? ib++ : ir++;
  }
  console.log(`   ${(t === 0 ? 'tick1' : String(t) + 's').padStart(4)}     ${String(ab).padStart(2)} / ${String(ar).padStart(2)}              ${String(ib).padStart(2)} / ${String(ir).padStart(2)}          ${ab + ar + ib + ir}`);
});
console.log('   recording: 12 / 12 armour, 36 / 36 infantry, reinforce=on');
console.log('');

console.log('2. WHERE THEY STAND - distance to the truck, bucketed');
const EDGE = [26, 34, 50, 75, 100, 150, 1e9], NAME = ['<26', '<34', '<50', '<75', '<100', '<150', '150+'];
run(SEED, [10, 30, 60, 90], (t, st) => {
  for (const [tag, want] of [['armour  ', true], ['infantry', false]]) {
    const row = new Array(EDGE.length).fill(0);
    let near = Infinity;
    for (const u of live(st, want)) {
      const d = Math.hypot(u.x / ONE, u.z / ONE);
      near = Math.min(near, d);
      for (let k = 0; k < EDGE.length; k++) if (d < EDGE[k]) { row[k]++; break; }
    }
    console.log(`   t=${String(t).padStart(2)}s ${tag} ` + row.map((v, k) => `${NAME[k]}:${String(v).padStart(2)}`).join(' ') + `  nearest ${f(near)} m`);
  }
});
console.log('');

console.log('3. THE ENVELOPE - 24 core seeds against the recording\'s one pass');
const MARKS = [10, 30, 60, 90], tank = {}, rifle = {};
for (const m of MARKS) { tank[m] = []; rifle[m] = []; }
for (let n = 0; n < 24; n++)
  run(SEED + n * 7919, MARKS, (t, st) => {
    let a = 0, r = 0;
    for (const u of live(st, null)) {
      const d2 = (u.x / ONE) ** 2 + (u.z / ONE) ** 2;
      if (isArmour(u.i)) { if (d2 < 34 * 34) a++; } else if (d2 < 26 * 26) r++;
    }
    tank[t].push(a); rifle[t].push(r);
  });
const band = (v) => `[${Math.min(...v)}, ${Math.max(...v)}] mean ${(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1)}`;
for (const [tag, set, col] of [['tanks within 34 m', tank, 0], ['riflemen within 26 m', rifle, 1]]) {
  console.log(`   ${tag}                 recording   inside?`);
  for (const m of MARKS) {
    const v = set[m], r = REC[m][col], inside = r >= Math.min(...v) && r <= Math.max(...v);
    console.log(`   ${String(m).padStart(3)}s  ${band(v).padEnd(24)} ${String(r).padStart(9)}   ${inside ? 'YES' : 'NO'}`);
  }
  console.log('');
}

console.log('4. THE ARMOUR\'S STANDOFF, measured against the core\'s OWN seam');
console.log('   C# StepArmour (Army.cs:557-576): unengaged -> front - Dir*9;');
console.log('   foe inside 24 m -> z - Dir*6 at a third speed; OVERRUN -> front - Dir*34.');
for (const seed of [SEED, SEED + 7919, SEED + 2 * 7919])
  run(seed, [10, 90], (t, st) => {
    const off = live(st, true).map((u) => Math.abs(u.z - frontlineZ(st.tape, u.x, HALF, HALF)) / ONE);
    console.log(`   seed ${seed} t=${String(t).padStart(2)}s  |z - seam|  median ${f(q(off, .5))}  p75 ${f(q(off, .75))}  max ${f(q(off, .999))}`);
  });
