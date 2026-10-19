// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WAR_TACTICS.md §4.12 THE ASSAULT and its §0.1 rows, read from the state only.
//
//     node tools/measure-assault.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=10800]
//
// Per side per seed: every assault's start tick, target, whether the target was unheld by that side at the start, how it
// ended (a holder flip = success, 1800 ticks = failure), the lull before it, the side's mean push on the assaulted lane
// at the start and its peak inside the next 600 ticks. §0.1: declared-then-happens (>= +8 m inside 600 ticks on >= 80%),
// lulls (no assault on either side on 25-60% of ticks; none starting inside 20 s of the side's last end), fail or win
// (30-70% flip the holder), the front moves visibly (a forward hull >= 16 m across the seam, push >= 32, on every seed).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 10800));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const ONE = 65536;
const NAME = ['RIDGE', 'HOLLOW', 'GAP'];
let starts = 0, unheld = 0, wins = 0, fails = 0, open = 0, built = 0, lullTicks = 0, ticks = 0, tooSoon = 0, seedsOver32 = 0;
const firstStarts = [], gaps = [];
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32; let over32 = false;
  const was = { '-1': null, '1': null }, lastEnd = { '-1': null, '1': null }, pending = [];
  const lines = [];
  for (let t = 0; t < TICKS; t++) {
    const holdersBefore = [0, 1, 2].map((o) => T.objectiveHolder(s, L.O_TACTICS, o));
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    let any = false;
    for (const side of [-1, 1]) {
      const ph = T.assaultPhase(s, L.O_TACTICS, side), tg = T.assaultTarget(s, L.O_TACTICS, side), n = T.assaultCount(s, L.O_TACTICS, side);
      if (ph === T.ASSAULT_PUSH) any = true;
      const prev = was[side];
      if (ph === T.ASSAULT_PUSH && (!prev || prev.ph !== T.ASSAULT_PUSH)) {
        starts++;
        const mine = side < 0 ? T.HOLDER_BULL : T.HOLDER_BEAR;
        const ok = holdersBefore[tg] !== mine; if (ok) unheld++;
        if (lastEnd[side] === null) firstStarts.push(tick); else { gaps.push(tick - lastEnd[side]); if (tick - lastEnd[side] < 1200) tooSoon++; }
        const lane = T.objectiveLane(s, L.O_TACTICS, tg);
        const lanePush = () => { let sum = 0, k = 0; for (let w = side < 0 ? 0 : 6; w < (side < 0 ? 6 : 12); w++) if (s[L.O_TACTICS + T.TAC_SLOT + w] === lane) { sum += s[L.O_TACTICS + T.TAC_PUSH + w]; k++; } return k ? sum / k / ONE : null; };
        pending.push({ side, until: tick + 600, at: lanePush(), peak: lanePush(), f: lanePush });
        lines.push(`${side < 0 ? 'bull' : 'bear'} #${n} t=${(tick / 60).toFixed(1)}s ${NAME[tg]} (lane ${lane}) ${ok ? 'unheld' : 'HELD BY ATTACKER'}`);
      }
      if (prev && prev.ph === T.ASSAULT_PUSH && ph !== T.ASSAULT_PUSH) {
        if (ph === T.ASSAULT_CONSOLIDATE) { wins++; lines[lines.length - 1] += ''; lines.push(`   ${side < 0 ? 'bull' : 'bear'} took ${NAME[tg]} after ${((tick - prev.start) / 60).toFixed(1)} s`); }
        else { fails++; lastEnd[side] = tick; lines.push(`   ${side < 0 ? 'bull' : 'bear'} failed on ${NAME[tg]} (30 s)`); }
      }
      if (prev && prev.ph === T.ASSAULT_CONSOLIDATE && ph === T.ASSAULT_IDLE) lastEnd[side] = tick;
      was[side] = { ph, start: ph !== (prev && prev.ph) ? tick : (prev ? prev.start : tick) };
    }
    for (let k = pending.length - 1; k >= 0; k--) { const p = pending[k]; const v = p.f(); if (v !== null && (p.peak === null || v > p.peak)) p.peak = v;
      if (tick >= p.until) { if (p.at !== null && p.peak !== null && p.peak - p.at >= 8) built++; else if (p.at === null) { /* no team on the lane at the start */ } pending.splice(k, 1); } }
    for (let w = 0; w < 12; w++) if (s[L.O_TACTICS + T.TAC_PUSH + w] >= 32 * ONE) over32 = true;
    ticks++; if (!any) lullTicks++;
  }
  for (const side of [-1, 1]) if (was[side] && was[side].ph === T.ASSAULT_PUSH) open++;
  if (over32) seedsOver32++;
  console.log(`seed ${seed}: bull ${T.assaultCount(s, L.O_TACTICS, -1)} assaults, bear ${T.assaultCount(s, L.O_TACTICS, 1)}`);
  for (const l of lines) console.log('  ' + l);
}
const ended = wins + fails;
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? (b[b.length >> 1] / 60).toFixed(1) + ' s' : '-'; };
console.log(`\nassaults started ${starts} (${(starts / SEEDS.length / 2).toFixed(1)} per side per ${(TICKS / 3600).toFixed(0)}-minute run); target unheld by the attacker at the start ${unheld} of ${starts}`);
console.log(`first starts ${firstStarts.map((t) => (t / 60).toFixed(1)).join(', ')} s (rule 20-40 s); lull before a later start median ${med(gaps)}, starts inside 20 s of the side's last end ${tooSoon}`);
console.log(`ended ${ended}: took the objective ${wins} (${ended ? (100 * wins / ended).toFixed(1) : '-'}%, row 30-70%), failed ${fails}; still running at the end ${open}`);
console.log(`declared then happens: lane push >= +8 m inside 600 ticks on ${built} of ${starts} (${starts ? (100 * built / starts).toFixed(1) : '-'}%, row >= 80%)`);
console.log(`lulls: no assault running on either side on ${(100 * lullTicks / ticks).toFixed(1)}% of ticks (row 25-60%); a forward hull >= 16 m across (push >= 32) on ${seedsOver32} of ${SEEDS.length} seeds (row: every seed)`);
