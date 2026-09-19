// THE LINE'S CONCENTRATION IN BOTH ENGINES (2026-09-19, B3 step 5).
// csharp-army.json records, every 5 s for 90 s, each side's infantry count, mean z and z SPREAD (the sd). It records
// an x spread for the ARMOUR only, and it has no squad structure at all. So of B3's two asserts - z sd PER SQUAD
// between 2 and 12 m, and the side's x sd against its own anchors - the recording carries NEITHER. What it does
// carry is the side-wide infantry z sd, and that is measured here on both engines at the same cadence, on the
// recording's own seed, with the core's depth taken from its own seam at each man's x.
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const tmp = mkdtempSync(join(tmpdir(), 'line-engines-'));
cpSync('/tmp/btc-phase0/packages/core/src', join(tmp, 'src'), { recursive: true });
{ const f = join(tmp, 'src', 'sim.js'); const src = readFileSync(f, 'utf8');
  const a = 'export function surfaceAt(st, x, z) {';
  if (src.split(a).length !== 2) { console.error('anchor not found once'); process.exit(2); }
  writeFileSync(f, src.replace(a, 'export function seamOfCore(st, x) { return seamAtX(st, x); }\n\n' + a)); }
const { init, step, seamOfCore } = await import(pathToFileURL(join(tmp, 'src', 'sim.js')).href);
const L = await import(pathToFileURL(join(tmp, 'src', 'state.js')).href);
const ONE = 65536;
const rec = JSON.parse(readFileSync('/tmp/btc-phase0/packages/core/test/vectors/csharp-army.json', 'utf8'));

const RIFLES = []; for (let i = 0; i < 96; i++) if ((i & L.ARMOUR_MASK) !== 0) RIFLES.push(i);
const sideOf = (i) => ((i & 4) === 0 ? -1 : 1);
const squadOf = (i) => (i >> 5) & 3;
const sdev = (a) => { if (!a.length) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length); };

const st = init(rec.seed), s = st.i32;
const alive = (i) => s[L.O_UNITS + i * L.U_WORDS + L.U_STATE] !== 0;
const depth = (i) => { const b = L.O_UNITS + i * L.U_WORDS; return (s[b + L.U_Z] - seamOfCore(st, s[b + L.U_X])) / ONE; };
const xOf = (i) => s[L.O_UNITS + i * L.U_WORDS + L.U_X] / ONE;

console.log(`seed ${rec.seed}, sampled every 5 s for 90 s, the core's depth taken from its own seam at each man's x`);
console.log(`t    |  recording infantry z sd   |  core infantry z sd (side-wide)  |  core z sd PER SQUAD (median)  |  core men`);
const out = [];
for (let sec = 0; sec <= 90; sec++) {
  if (sec > 0) for (let k = 0; k < 60; k++) step(st, 0, 0, 0, ONE, 0);
  if (sec % 5) continue;
  const row = rec.rows.find((r) => r.t === sec);
  const line = [];
  for (const [name, sd] of [['bull', -1], ['bear', 1]]) {
    const men = RIFLES.filter((i) => alive(i) && sideOf(i) === sd && depth(i) * -sd >= -40);
    const zsd = sdev(men.map(depth));
    const sq = [];
    for (let q = 0; q < 3; q++) {
      const mine = men.filter((i) => squadOf(i) === q);
      if (mine.length >= 4) sq.push(sdev(mine.map(depth)));
    }
    sq.sort((a, b) => a - b);
    line.push({ name, n: men.length, zsd, med: sq.length ? sq[sq.length >> 1] : NaN, xsd: sdev(men.map(xOf)) });
  }
  const recB = row ? row.bullInf.spread : NaN, recR = row ? row.bearInf.spread : NaN;
  out.push({ t: sec, recB, recR, core: line });
  console.log(`${String(sec).padStart(3)}  |  bull ${recB.toFixed(2).padStart(6)} bear ${recR.toFixed(2).padStart(6)}  |  `
    + `bull ${line[0].zsd.toFixed(2).padStart(6)} bear ${line[1].zsd.toFixed(2).padStart(6)}  |  `
    + `bull ${line[0].med.toFixed(2).padStart(6)} bear ${line[1].med.toFixed(2).padStart(6)}  |  `
    + `${line[0].n}/${line[1].n}`);
}
const from30 = out.filter((o) => o.t >= 30);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\nfrom t=30, when the recording says it is a steady grind:`);
console.log(`  recording, side-wide infantry z sd   mean ${mean(from30.flatMap((o) => [o.recB, o.recR])).toFixed(2)} m`);
console.log(`  core,      side-wide infantry z sd   mean ${mean(from30.flatMap((o) => o.core.map((c) => c.zsd))).toFixed(2)} m`);
console.log(`  core,      PER SQUAD z sd (median)   mean ${mean(from30.flatMap((o) => o.core.map((c) => c.med)).filter(Number.isFinite)).toFixed(2)} m`);
console.log(`  core,      side x sd                 mean ${mean(from30.flatMap((o) => o.core.map((c) => c.xsd)).filter(Number.isFinite)).toFixed(2)} m`);
console.log(`\nB3's band is 2-12 m PER SQUAD. The recording has no squads and no infantry x, so it cannot be asked either.`);
