// TALLY: THE SECOND, MINIMAL TEST GAME (kanban #202, the owner 2026-10-07: "a round of a second, minimal test plugin opens,
// replays and settles on the same nodes as nextblock").
//
// Nothing like the truck: each tick takes one input number (the first of the five words a batch carries per tick), the
// score is their sum, and a run finishes at its round's run length - DELIVERED, scored by the sum. It answers the same
// adapter face every core does (start, eventsOf, step, stateHash, result, runTicksFits) and draws no picture: `picture`
// is a game's optional extra, and the engine must not need it.
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The longest run a tally round may name. */
export const TALLY_RUN_TICKS = 600;

export const CORE = Object.freeze({
  name: 'tally',
  RUN_TICKS: TALLY_RUN_TICKS,
  runTicksFits: (t) => Number.isInteger(t) && t >= 1 && t <= TALLY_RUN_TICKS,
  INPUT_WORDS: 5,
  start: (seedWord, config = {}, { runTicks } = {}) => ({ seed: seedWord | 0, sum: 0, ticks: 0, length: runTicks ?? TALLY_RUN_TICKS }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) {
    if (st.ticks >= st.length) return;
    st.sum += w[0] | 0;
    st.ticks++;
  },
  stateHash: (st) => sha(`tally:${st.seed}:${st.sum}:${st.ticks}:${st.length}`),
  result: (st) => ({ outcome: st.ticks < st.length ? null : 'DELIVERED', score: st.sum }),
});
