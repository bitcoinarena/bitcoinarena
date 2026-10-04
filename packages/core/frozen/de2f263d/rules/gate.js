// The far end of the run, and the clock that ends it.
//
// The block IS the round. A run still on the road when the block closes has
// missed it: the freight is lost and the score is zero. Without that the clock
// counted down and did nothing, which taught the player that time is free -
// and time is the only cost left on dawdling once exposure stopped paying for
// it.

import { ONE, add, sub, abs, mulFast, div } from '../fixed.js';
import { MINER_X } from './map.js';

/**
 * THE DELIVERY LINE IS THE MINER'S OWN FACE, and it moves with it (measured 2026-09-19 in the cab, on the build
 * that grew the world east). This was 114 m, written when the miner's origin was 114.4; when the origin went to
 * 169 m the line stayed behind, so the truck delivered in open ground 53 m short of the building - measured, the
 * run ended with the truck at x 115.7 and the lobby came back with 4,505 sat in the block. One number, taken from
 * the map, so the two cannot drift again.
 */
export const GATE_X = sub(MINER_X, 26214);          // 168.6 m: 0.4 m inside the origin, where 114 sat against 114.4
export const HALF_MOUTH = Math.imul(34, ONE);
/**
 * A compressed block: 180 s at 60 Hz. Bitcoin's ten minutes is far too long to wait for a score - that still
 * stands - but 150 s was too short for the war the doctrine now runs, and the doctrine's own clocks decide it
 * (WAR_TACTICS, RULED 2026-09-19): §4.12 starts a side's first assault at 20-40 s, runs it up to 30 s, consolidates
 * 15 s and re-arms 45-90 s later, so 150 s holds ONE assault a side and cuts the second off mid-build; §4.14 needs
 * six closed 10 s candles before a trend can exist at all, 40% of a 150 s round with no trend possible; and §4.13's
 * seam is an SMA(21) of 5 s samples, which takes 105 s to turn, so in 150 s the market moves the front at most
 * once. At 180 s each side gets two declared assaults, a trend for two thirds of the round, and a front that has
 * visibly turned.
 *
 * AND IT IS A DEFAULT, NOT THE RULE. `player_run_duration` (T_run) is a RoundContract field, and the protocol
 * already makes a round's length the round's core's - `runLengthIsTheCores(contract, coreTicks)` refuses a contract
 * that disagrees with the core it names. So this number is what a round gets when no contract sets one (a SIM
 * round, §4.13); a contract wins.
 */
export const BLOCK_TICKS = 10800;

/**
 * THE RUN LENGTH IS THE ROUND'S (the owner 2026-10-01, the 82/90 hard fork: "The round length must be part of the contract
 * - not a fixed constant. It must be part of the round announcement"). A run ends MISSED after the ticks its round's
 * contract names (blockTicks), handed to `init`; BLOCK_TICKS stays the default a run without a round gets (practice, a
 * SIM round) and the longest a round may name. A run of BLOCK_TICKS is the same, tick for tick and hash for hash, as the
 * core before this (the length is not in the hashed state).
 */
export const MAX_RUN_TICKS = BLOCK_TICKS;
export function runTicksIsValid(t) { return Number.isInteger(t) && t >= 1 && t <= MAX_RUN_TICKS; }

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
export function outcome(state, x, z, hp, tickInBlock, runTicks = BLOCK_TICKS) {
  if (state !== RUN_LIVE) return state;
  if (tickInBlock >= runTicks) return RUN_MISSED;
  if (hp <= 0) return RUN_WRECKED;
  if (arrived(x, z)) return RUN_DELIVERED;
  return RUN_LIVE;
}
