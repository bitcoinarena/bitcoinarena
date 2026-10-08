// GIVING GROUND, IN BOTH ENGINES, IN METRES (2026-09-19, A11b close-out).
// The recording has no push word, so the two engines cannot be compared on §4.10's word. What they CAN be compared on
// is the thing the word is supposed to produce: a side's armour standing further back from the seam than it did.
// csharp-army.json holds each side's mean armour z every 5 s for 90 s on a flat world with the seam at 0; this takes
// the same reading from the core, at the same cadence, in the same units, and counts how often each engine's line
// moves BACK between two samples.
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
// The core's OWN seam, hooked out of a copy the same way tools/measure-war.mjs does it: the seam wanders with the
// chart, and a depth measured from z=0 would be measuring a different line from the one the army holds.
const tmp = mkdtempSync(join(tmpdir(), 'give-engines-'));
cpSync('/tmp/btc-phase0/packages/nextblock/src', join(tmp, 'src'), { recursive: true });
{
  const f = join(tmp, 'src', 'sim.js'); const src = readFileSync(f, 'utf8');
  const anchor = 'export function surfaceAt(st, x, z) {';
  if (src.split(anchor).length !== 2) { console.error('anchor not found once'); process.exit(2); }
  writeFileSync(f, src.replace(anchor, 'export function seamOfCore(st, x) { return seamAtX(st, x); }\n\n' + anchor));
}
const { init, step, seamOfCore } = await import(pathToFileURL(join(tmp, 'src', 'sim.js')).href);
import * as L from '/tmp/btc-phase0/packages/nextblock/src/state.js';
import * as T from '/tmp/btc-phase0/packages/nextblock/src/rules/tactics.js';
const ONE = 65536;
const rec = JSON.parse(readFileSync('/tmp/btc-phase0/packages/nextblock/test/vectors/csharp-army.json', 'utf8'));

// ---- the recording ----
const recSeries = { bull: [], bear: [] };
for (const r of rec.rows) {
  recSeries.bull.push({ t: r.t, depth: Math.abs(r.bullArmour.z), n: r.bullArmour.n, spread: r.bullArmour.spread });
  recSeries.bear.push({ t: r.t, depth: Math.abs(r.bearArmour.z), n: r.bearArmour.n, spread: r.bearArmour.spread });
}

// ---- the core, same seed, same cadence, depth measured from the core's own seam at each hull's x ----
const st = init(rec.seed), s = st.i32;
const ARMOUR = []; for (let i = 0; i < 96; i++) if ((i & L.ARMOUR_MASK) === 0) ARMOUR.push(i);
const sideOf = (i) => T.teamOf(i).side;
const alive = (i) => s[L.O_UNITS + i * L.U_WORDS + L.U_STATE] !== 0;
const coreSeries = { bull: [], bear: [] };
const SECONDS = 90;
for (let sec = 0; sec <= SECONDS; sec++) {
  if (sec > 0) for (let k = 0; k < 60; k++) step(st, 0, 0, 0, ONE, 0);
  if (sec % 5) continue;
  for (const [name, sd] of [['bull', -1], ['bear', 1]]) {
    const live = ARMOUR.filter((i) => alive(i) && sideOf(i) === sd);
    if (!live.length) { coreSeries[name].push({ t: sec, depth: NaN, n: 0, spread: NaN }); continue; }
    // depth BEHIND its own side of the seam, in metres: z minus the seam at that hull's own x, signed by the side.
    const ds = live.map((i) => {
      const b = L.O_UNITS + i * L.U_WORDS;
      return ((s[b + L.U_Z] - seamOfCore(st, s[b + L.U_X])) / ONE) * sd;
    });
    const m = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd2 = Math.sqrt(ds.reduce((a, b) => a + (b - m) * (b - m), 0) / ds.length);
    coreSeries[name].push({ t: sec, depth: m, n: live.length, spread: sd2 });
  }
}

const backSteps = (series, from) => {
  let back = 0, seen = 0, worst = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].t <= from) continue;
    const d = series[i].depth - series[i - 1].depth;      // depth grows = standing further back = giving ground
    if (!isFinite(d)) continue;
    seen++;
    if (d > 0.5) { back++; if (d > worst) worst = d; }
  }
  return { back, seen, worst };
};

console.log('GIVING GROUND, both engines, metres of depth from the seam, sampled every 5 s');
console.log('  (the recording walks in from 77 m and the core spawns on post, ruled 2026-09-19, so the');
console.log('   comparison is taken from t=20 s, after the recording has closed.)');
for (const name of ['bull', 'bear']) {
  const R = backSteps(recSeries[name], 20), C = backSteps(coreSeries[name], 20);
  console.log(`  ${name}: recording gave ground in ${R.back} of ${R.seen} intervals (worst ${R.worst.toFixed(1)} m), `
    + `core in ${C.back} of ${C.seen} (worst ${C.worst.toFixed(1)} m)`);
}
console.log('  series, depth in m (t: recording -> core):');
for (let i = 0; i < recSeries.bull.length; i++) {
  const r = recSeries.bull[i], c = coreSeries.bull[i];
  if (!c) continue;
  console.log(`    t${String(r.t).padStart(2)}  bull rec ${r.depth.toFixed(1).padStart(5)} (n ${String(r.n).padStart(2)}, sd ${r.spread.toFixed(1)})`
    + `   core ${c.depth.toFixed(1).padStart(5)} (n ${String(c.n).padStart(2)}, sd ${isFinite(c.spread) ? c.spread.toFixed(1) : '-'})`);
}
