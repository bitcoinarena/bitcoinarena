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
import { init, step, HALF_X, HALF_Z } from '../src/sim.js';
import { MAX_UNITS, unitBase, U_HP, U_SIDE, U_X, U_Z, O_TRUCK, T_X, O_AIR, AIR_BULL, AIR_BEAR } from '../src/state.js';
import { frontlineZ } from '../src/rules/frontline.js';

const ONE = 65536;
const SEED = 20260901;             // the recording's own seed
const isArmour = (i) => (i & 3) === 0;   // `sim.js:70`, every fourth slot
// The seam must be sampled with the SIM's own field, not with C# `FrontX`.
// The first version of this tool passed 92 for both half-extents because that
// is the C# constant; the core's field is 130 by 85 (`sim.js:45-46`), so it
// was reading a different seam than the one the units actually hold on to.

/** The recording, read off `test/vectors/csharp-army.json`'s courier pass. */
const REC = { 10: [8, 0], 30: [8, 21], 60: [14, 18], 90: [17, 27] };

/** The sortie clocks, pinned from outside the rules. The pass is air "none". */
const CLOCK_HIGH = 1 << 30;
/**
 * The sortie clocks live in the STATE WORDS at `O_AIR`, not as properties on
 * `st`. An earlier version of this helper wrote `st.heliClock`, which is not a
 * key on the state at all, so it held nothing off and every row it produced
 * was measured with the air ON while the caption said "air off".
 */
const airOff = (st) => {
  st.i32[O_AIR + AIR_BULL] = CLOCK_HIGH;
  st.i32[O_AIR + AIR_BEAR] = CLOCK_HIGH;
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

console.log('4. THE SEAM, which is what the neighbourhood was really about');
console.log('   The recording pins `FrontlineAt = _ => 0f` - a flat front through the');
console.log('   parked truck. The core\'s is the price tape, and `sim.js:635` samples it');
console.log('   ONCE at the TRUCK\'s x for the whole army, where C# samples `FrontlineAt(v.x)`');
console.log('   per unit (`Army.cs:557` and `:651`).');
{
  const st = init(SEED);
  airOff(st);
  step(st, 0, 0, 0, 0, 0);
  const at = (x) => frontlineZ(st.tape, Math.imul(x, ONE), HALF_X, HALF_Z) / ONE;
  const xs = [-120, -80, -40, 0, 40, 80, 120];
  console.log('   seam z across x: ' + xs.map((x) => at(x).toFixed(1).padStart(7)).join(''));
  const hold = [];
  for (let s2 = 2; s2 <= 60 * 90; s2++) {
    step(st, 0, 0, 0, 0, 0); airOff(st);
    if (s2 !== 60 * 90) continue;
    const seam = frontlineZ(st.tape, st.i32[O_TRUCK + T_X], HALF_X, HALF_Z) / ONE;
    for (const u of live(st, true)) {
      const sc = (Math.imul(u.i, 2654435761) >>> 20) & 1023;
      const so = 9 + (sc * 10 / 1024) - 5;
      hold.push(Math.abs(u.z / ONE - (seam + (u.side < 0 ? -1 : 1) * so)));
    }
  }
  console.log(`   at t = 90 s, |z - the tank's OWN hold|: median ${f(q(hold, .5))} m, p75 ${f(q(hold, .75))} m`);
  console.log('   The armour holds its line. It is the line that is not where the recording\'s is.');
}
console.log('');

console.log('5. THE SAME COUNT WITH THE FRONT PINNED AT THE TRUCK');
console.log('   `frontlineZ` returns 0 for a tape of zero span (`rules/frontline.js:32`),');
console.log('   so a flat tape IS C#\'s `_ => 0f`. Held flat from outside the rules.');
{
  const tank2 = {}, rifle2 = {};
  for (const m of MARKS) { tank2[m] = []; rifle2[m] = []; }
  for (let n = 0; n < 24; n++) {
    const st = init(SEED + n * 7919);
    const hold = () => { airOff(st); st.tape.fill(ONE); };
    hold();
    for (let s2 = 1; s2 <= 60 * 90; s2++) {
      step(st, 0, 0, 0, 0, 0); hold();
      if (s2 % 60 || !MARKS.includes(s2 / 60)) continue;
      let a = 0, r = 0;
      for (const u of live(st, null)) {
        const d2 = (u.x / ONE) ** 2 + (u.z / ONE) ** 2;
        if (isArmour(u.i)) { if (d2 < 34 * 34) a++; } else if (d2 < 26 * 26) r++;
      }
      tank2[s2 / 60].push(a); rifle2[s2 / 60].push(r);
    }
  }
  const inb = (v, r) => (r >= Math.min(...v) && r <= Math.max(...v) ? 'YES' : 'NO ');
  console.log('    t    tanks within 34 m       rec  in?    riflemen within 26 m    rec  in?');
  for (const m of MARKS)
    console.log(`   ${String(m).padStart(2)}s   ${band(tank2[m]).padEnd(22)} ${String(REC[m][0]).padStart(3)}  ${inb(tank2[m], REC[m][0])}    ${band(rifle2[m]).padEnd(22)} ${String(REC[m][1]).padStart(3)}  ${inb(rifle2[m], REC[m][1])}`);
}
