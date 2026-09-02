// (e) step 0: what still crosses the bridge into the core every tick.
//
// READ-ONLY. `CoreDrivenTruck.Update()` calls three uploads. `UploadGround` is
// gated on `terrain.Revision` and `UploadSolids` on a count checked once a
// second, so both are round setup that happens to be re-checked. `UploadArmour`
// is neither: it runs every frame, unguarded, straight out of `field.Army`.
// `setUnits` has no caller anywhere - not in Unity, not in these tools, not in
// the tests - so the host branch of the score's danger (`sim.js:881`) is dead
// and the score already reads the core's own army.
//
// (e) step 0. READ-ONLY. What does the core carry on its own, and what only
// exists when Unity hands it over every tick?
//
// `UploadArmour` runs in `CoreDrivenTruck.Update()` unguarded, every frame,
// out of `field.Army` - while `UploadGround` is gated on a terrain revision
// and `UploadSolids` on a count checked once a second. So armour is THE
// per-tick host input that is not player input. `setUnits` has no Unity caller
// at all.
import { readFileSync } from 'node:fs';
import { init, step, setArmour } from '../src/sim.js';
import { hash, O_TRUCK, T_X, T_Z, T_HP } from '../src/state.js';
const ONE = 65536;
const DIR = new URL('../../../test-vectors/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(DIR + 'index.json', 'utf8'));

const run = (v, feed) => {
  const st = init(v.seed);
  const seen = new Set();
  for (let t = 0; t < v.ticks; t++) {
    const [a, b, c, d, e] = v.inputs[t];
    if (feed) feed(st, t);
    step(st, a, b, c, d, e);
    seen.add(st.armour ? st.armour.n : -1);
  }
  return { h: hash(st), seen: [...seen].sort((x, y) => x - y), st };
};

console.log('1. WHAT THE CORE CARRIES WITHOUT A HOST');
for (const e of index.vectors) {
  const v = JSON.parse(readFileSync(DIR + e.name + '.json', 'utf8'));
  const r = run(v, null);
  console.log(`   ${e.name.padEnd(10)} st.armour.n over the round: ${r.seen.join(',')}` +
              `   truck hp ${(r.st.i32[O_TRUCK + T_HP] / ONE).toFixed(2)}`);
}
console.log('   The core simulates 24 tanks of its own. None of them is in st.armour,');
console.log('   because nothing in step() ever writes it - only setArmour and setUnits do.');
console.log('');

console.log('2. WHAT CHANGES WHEN A HOST FEEDS IT');
const v = JSON.parse(readFileSync(DIR + 'straight.json', 'utf8'));
const plain = run(v, null);
// A tank put where the truck actually is, from t=600 on. The first attempt
// parked one at (0, 30), which the truck on `straight` never comes within a
// hull of - it proved nothing, and a null result from a test that could not
// have fired is not a result.
const one = new Int32Array(2);
const fed = run(v, (st, t) => {
  if (t < 600) return;
  one[0] = st.i32[O_TRUCK + T_X];
  one[1] = st.i32[O_TRUCK + T_Z];
  setArmour(st, 1, one);
});
console.log(`   straight, no host        ${plain.h.slice(0, 16)}  x=${(plain.st.i32[O_TRUCK + T_X] / ONE).toFixed(1)} z=${(plain.st.i32[O_TRUCK + T_Z] / ONE).toFixed(1)}`);
console.log(`   straight, host tank on the truck from t=600  ${fed.h.slice(0, 16)}  x=${(fed.st.i32[O_TRUCK + T_X] / ONE).toFixed(1)} z=${(fed.st.i32[O_TRUCK + T_Z] / ONE).toFixed(1)}`);
console.log(`   same round? ${plain.h === fed.h ? 'YES' : 'NO - the outcome depends on per-tick host input'}`);
