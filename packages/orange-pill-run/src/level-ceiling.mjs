// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Orange Pill Run - THE LEVEL'S CEILING (kanban #3332, audit 2 #3330): what a search with the game's own sim reaches on a built level. The day's
// level is public data, so anyone can run this search before the round opens; the round service runs the same one (in a worker thread, once per
// round) and holds a run that comes near it for the owner. A beam search: every `k` steps the runner jumps or not, the `beam` best worlds go on
// (finished and fast first, then no hits, distance, sats and stomps). Stage levels 2026-11-22: test-3 999, test-4 1034, test-5 939 points, each
// finished in 22.98 s; the real players' best runs reached 33 %, 77 % and 44 % of them.
import { newWorld, stepWorld, scoreOf, MAX_STEPS } from "./sim/index.js";

export const CEILING_K = 4, CEILING_BEAM = 60;

const fit = (W) => (W.stats.finished ? 1e7 - W.time * 1000 : 0) - W.stats.hits * 5000 + W.p.x + 30 * (W.stats.coins + 5 * W.stats.blocks + 10 * W.stats.stomps);

/** The best run the search finds on level L: { total, timeS, finished, steps } (total 0 when it finishes none). */
export function levelCeiling(L, { k = CEILING_K, beam = CEILING_BEAM } = {}) {
  let front = [newWorld(L)], best = null, steps = 0;
  for (let lvl = 0; lvl < MAX_STEPS / k && front.length; lvl++) {
    const next = [];
    for (const W0 of front) for (const jump of [false, true]) {
      const W = structuredClone(W0);
      for (let s = 0; s < k && !W.done; s++) stepWorld(W, { jump });
      steps += k;
      if (W.done) { if (W.stats.finished && (!best || fit(W) > fit(best))) best = W; } else next.push(W);
    }
    next.sort((a, b) => fit(b) - fit(a)); front = next.slice(0, beam);
    if (best && (!front.length || fit(best) > fit(front[0]))) break;
  }
  if (!best) return { total: 0, timeS: null, finished: false, steps };
  return { total: scoreOf(best).total, timeS: Math.round(best.time * 1000) / 1000, finished: true, steps };
}
