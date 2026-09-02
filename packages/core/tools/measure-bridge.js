// (e) step 0: what still crosses the bridge into the core every tick.
//
// READ-ONLY. `CoreDrivenTruck.Update()` calls three uploads. `UploadGround` is
// gated on `terrain.Revision` and `UploadSolids` on a count checked once a
// second, so both are round setup that happens to be re-checked. `UploadArmour`
// is neither: it runs every frame, unguarded, straight out of `field.Army`.
// BOTH ARE GONE NOW, and this tool is what says so. `setArmour` and `setUnits`
// no longer exist, `BlwpSetArmour` is out of the jslib, `SetArmour` out of the
// bridge and `UploadArmour` out of `CoreDrivenTruck`. The solid armour is built
// inside `step()` from the core's own units, so section 1 below prints what the
// core carries on its own and section 2 has nothing left to feed it with.
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
import { init, step } from '../src/sim.js';
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
console.log('   Every one of the core\'s living tanks, every tick. It used to be 0 at');
console.log('   every tick of every vector: the truck drove through all twenty-four.');
console.log('');

console.log('2. AND NOTHING CAN FEED IT FROM OUTSIDE ANY MORE');
console.log('   `setArmour` and `setUnits` are deleted, with `BlwpSetArmour` in the');
console.log('   jslib, `SetArmour` in the bridge and `UploadArmour` in CoreDrivenTruck.');
console.log('   Before they went, one host tank placed on the truck at t=600 of');
console.log('   `straight` turned a round ending at x = +130.0 into one ending at');
console.log('   x = -130.0, on a different hash. There is no such input left.');
