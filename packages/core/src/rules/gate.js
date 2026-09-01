// The far end of the run, and the clock that ends it.
//
// The block IS the round. A run still on the road when the block closes has
// missed it: the freight is lost and the score is zero. Without that the clock
// counted down and did nothing, which taught the player that time is free -
// and time is the only cost left on dawdling once exposure stopped paying for
// it.

import { ONE, add, sub, abs, mulFast, div } from '../fixed.js';

export const GATE_X = Math.imul(114, ONE);
export const HALF_MOUTH = Math.imul(34, ONE);
/** A compressed block: 150 s at 60 Hz. Bitcoin's ten minutes is far too long
 *  to wait for a score. */
export const BLOCK_TICKS = 9000;

export const RUN_LIVE = 0;
export const RUN_DELIVERED = 1;
export const RUN_WRECKED = 2;
export const RUN_MISSED = 3;

/** Has the courier crossed the line, inside the mouth? */
export const arrived = (x, z) => x >= GATE_X && abs(z) <= HALF_MOUTH;

/**
 * Advances the run's outcome. Returns the new state word.
 *
 * Order matters: a wreck beats an arrival in the same tick, and a missed block
 * beats both - a truck that is destroyed as the block closes did not deliver.
 */
export function outcome(state, x, z, hp, tickInBlock) {
  if (state !== RUN_LIVE) return state;
  if (tickInBlock >= BLOCK_TICKS) return RUN_MISSED;
  if (hp <= 0) return RUN_WRECKED;
  if (arrived(x, z)) return RUN_DELIVERED;
  return RUN_LIVE;
}
