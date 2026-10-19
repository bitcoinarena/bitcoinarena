// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARRIVAL CARD'S RUNS (2026-09-25: the card prints the core's E, T and C, and their product is the score).
//
// 72 DELIVERED runs - nine lanes, eight seeds, from x 96 heading east - each with the four words the card reads at
// delivery: S_EXPOSURE (Q16.16 metres), S_ELAPSED (ticks), S_CARGO (Q16.16 bed fraction) and S_DELIVERED (the core's
// latched scoreOf, whole points). The EditMode check TheCardsProductIsTheCoresScore feeds each through the real C#
// formatter; core/test/arrival-card-runs.test.js fails if this file is not what the core produces now.
//
// SO THAT ALL THREE FACTORS MOVE (RULED 2026-09-25), each run gets:
//   a HOLD before it drives (0, 3000, 6000 or 10300 ticks braked) and a THROTTLE (1, 0.1, 0.02 or 0.01) - T from the 1.5
//     clamp down to about 0.364. 0.25 CANNOT be reached by a delivered run on this core: the block closes at BLOCK_TICKS
//     10800 and a miss beats an arrival, so a delivered T is at least 3900/10799. The 10300 hold is paired with full
//     throttle only and the 6000 hold with 0.02 or faster, so every run delivers; no missed run stands in for the clamp.
//   a CARGO WORD WRITTEN BY THIS FIXTURE at init (0.20, 0.45, 0.70 or 0.95 of a bed) - A FIXTURE WRITE, NOT A PLAYER
//     INPUT. This core sets S_CARGO once, in init, to 45875 (0.70), and nothing a player does changes it (submitLoad
//     sets the heat); the live card will read load 0.70000 until the core grows a cargo input. The write is here only so
//     the product check is not stuck on 0.70.
//
//   node packages/nextblock/tools/arrival-card-runs.mjs      (writes test/fixtures/arrival-card-runs.json)
import { writeFileSync } from 'node:fs';
import { init, step, teleport } from '../src/sim.js';
import { O_SCORE, S_EXPOSURE, S_ELAPSED, S_CARGO, S_DELIVERED, S_STATE } from '../src/state.js';
import { exposure5, time5, cargo5 } from '../src/rules/score.js';

const ONE = 65536, EAST = 16384;
export const LANES = [-30, -20, -10.2, -6, 0, 6, 10.2, 20, 30];
export const SEEDS = 8;
export const THROTTLES = [1, 0.1, 0.02, 0.01];
export const HOLDS = [0, 3000, 6000, 10300];
export const CARGOES = [0.2, 0.45, 0.7, 0.95];

export function arrivalCardRuns() {
  const runs = [];
  LANES.forEach((lane, li) => {
    for (let k = 0; k < SEEDS; k++) {
      const st = init((0x51eed + k * 7919) | 0);
      teleport(st, 96 * ONE, Math.round(lane * ONE), EAST);
      const cargo = CARGOES[(li + k) % 4];
      st.i32[O_SCORE + S_CARGO] = Math.round(cargo * ONE);        // A FIXTURE WRITE, not a player input (see above)
      const hold = HOLDS[(li + (k >> 1)) % 4];
      // PAIRED SO ALL 72 DELIVER: the 10300 hold only at full throttle, and the 6000 hold at 0.02 or faster (0.01 takes
      // about 4890 ticks from here, 6000 + 4890 passes the block's 10800 - measured: 4 of 72 MISSED before this pairing).
      const pick = THROTTLES[k % 4];
      const throttle = hold === 10300 ? 1 : hold === 6000 && pick < 0.02 ? 0.02 : pick;
      for (let t = 0; t < hold; t++) step(st, 0, 0, ONE, 0, ONE);
      for (let t = 0; t < 10800 && st.i32[O_SCORE + S_STATE] === 0; t++) step(st, Math.round(throttle * ONE), 0, 0, 0, ONE);
      const s = st.i32;
      runs.push({ lane, seed: k, hold, throttle, fixtureCargo: cargo, state: s[O_SCORE + S_STATE], exposure: s[O_SCORE + S_EXPOSURE],
        elapsed: s[O_SCORE + S_ELAPSED], cargo: s[O_SCORE + S_CARGO], delivered: s[O_SCORE + S_DELIVERED],
        // the core's own factors of those words (score.js), so the C# card's are checked factor by factor, not only as a product
        e5: exposure5(s[O_SCORE + S_EXPOSURE]), t5: time5(s[O_SCORE + S_ELAPSED]), c5: cargo5(s[O_SCORE + S_CARGO]) });
    }
  });
  return runs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = arrivalCardRuns();
  writeFileSync(new URL('../test/fixtures/arrival-card-runs.json', import.meta.url), JSON.stringify({ runs }, null, 1) + '\n');
  console.log(`${runs.length} runs, ${runs.filter((r) => r.state === 1).length} DELIVERED`);
}
