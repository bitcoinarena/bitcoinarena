// THE WORLD'S ENVELOPE, in one print: what the core holds, what the drawn miner occupies, and whether anything of
// the world stands under the building (the owner 2026-09-19 15:58, miner-entrance-still-covered-1558.jpg).
//
//   node packages/core/tools/measure-world.mjs
import { readFileSync } from 'node:fs';
import { HALF_X, HALF_Z, init, step, submitLiquidation } from '../src/sim.js';
import { MINER_X, MINER_DOOR_X, POST_X } from '../src/rules/map.js';
import { CANDLE_WEST, CANDLE_EAST, CANDLES, BAND_X } from '../src/rules/candles.js';
import { FIELD_SLOT } from '../src/rules/frontline.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
const ONE = 65536, m = (q) => (q / ONE).toFixed(2).padStart(8);

// the drawn miner, from the model, through DeliveryGate's turn and (1, 0.45, 1) scale
function minerWest() {
  const d = readFileSync(new URL('../../../unity-proto/Assets/Models/bitcoin_miner_megastructure.glb', import.meta.url).pathname);
  const total = d.readUInt32LE(8);
  let off = 12, js = null;
  while (off < total) { const len = d.readUInt32LE(off), type = d.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) js = JSON.parse(d.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len; }
  let far = -1e9;                                    // the largest model x = the westernmost world x
  for (const a of js.accessors) if (a.type === 'VEC3' && a.max && a.componentType === 5126) far = Math.max(far, a.max[0]);
  return far;                                        // metres west of the miner's origin
}
const west = minerWest();
console.log('THE CORE HOLDS');
console.log(`  map half width        ${m(HALF_X)} m        half depth ${m(HALF_Z)} m`);
console.log(`  post office origin    ${m(POST_X)} m`);
console.log(`  miner origin          ${m(MINER_X)} m`);
console.log(`  miner door            ${m(MINER_DOOR_X)} m   <- chart, roads and armour stop here`);
console.log(`  chart field           ${m(CANDLE_WEST)} .. ${m(CANDLE_EAST)} m, ${CANDLES} slots of ${m(FIELD_SLOT)} m`);
console.log(`  levelled band         ${m(-BAND_X)} .. ${m(BAND_X)} m`);
console.log('\nTHE DRAWN MINER');
console.log(`  reaches west of its origin by ${west.toFixed(1)} m -> its west edge stands at x ${(MINER_X / ONE - west).toFixed(1)} m`);

const st = init(1), s = st.i32;
for (let t = 0; t < 900; t++) step(st, ONE, 0, 0, 0, 0);
let onDeck = 0, tankTicks = 0, eastMost = -1e9;
for (let t = 0; t < 3600; t++) {
  if (t % 600 === 300) submitLiquidation(st, 4000000);
  step(st, ONE, 0, 0, 0, 0);
  for (let i = 0; i < L.UNITS; i += 4) {
    const b = L.O_UNITS + i * L.U_WORDS;
    if (s[b + L.U_HP] <= 0 || s[b + L.U_STATE] === 0) continue;
    tankTicks++;
    const x = s[b + L.U_X] / ONE;
    if (x > eastMost) eastMost = x;
    if (x > MINER_X / ONE - west) onDeck++;
  }
}
const lastSlot = CANDLE_EAST / ONE, building = MINER_X / ONE - west;
console.log(`  [raw] door ${MINER_DOOR_X / ONE} building ${building} west ${west}`);
console.log('\nWHAT STANDS UNDER THE DRAWN BUILDING (seed 1, 60 s with nukes)');
console.log(`  easternmost living tank   x ${eastMost.toFixed(1)} m`);
console.log(`  tank-ticks on its deck    ${onDeck} of ${tankTicks}`);
console.log(`  last chart slot ends      x ${lastSlot.toFixed(2)} m   ${lastSlot <= building ? 'clear' : 'UNDER THE BUILDING'}`);
console.log(`  road ribbon ends          x ${(MINER_DOOR_X / ONE).toFixed(2)} m   ${MINER_DOOR_X / ONE <= building ? 'clear' : 'UNDER THE BUILDING'}`);
console.log(`  building west edge        x ${building.toFixed(2)} m`);
