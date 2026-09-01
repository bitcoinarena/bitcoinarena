// The load, ported from CargoBay.
//
// The sats aboard are the transaction's fee and go to the miner - they are not
// the player's pay, and the UI was wrong about that for a while. What a load
// buys the player is the cargo factor in the score, and the heat it attracts.

import { ONE, add, sub, mulFast, div, clamp, min } from '../fixed.js';

const BED_LENGTH = 196608;      // 3.0 m
const COLUMNS = 2;
export const BED_ROOM = Math.imul(BED_LENGTH, COLUMNS) >> 16;   // in Q16.16 units

const HEAT_AT_SATS = 20000;

/** Room one transaction takes, by vsize. Four sizes, as in the C#. */
export function roomFor(vsize) {
  if (vsize < 250) return 36044;      // 0.55
  if (vsize < 600) return 51118;      // 0.78
  if (vsize < 1500) return 68812;     // 1.05
  return 88474;                        // 1.35
}

/** Bed fill, 0..ONE. */
export const fill = (used) => clamp(div(used, Math.imul(BED_LENGTH, COLUMNS)), 0, ONE);

/**
 * Heat: how hard the load is hunted.
 *
 * Fees drive it, with a second term for the raw value moved, because a whale
 * with a modest fee is still worth stopping.
 */
export function heat(feeSats, btcHundredths) {
  const byFee = clamp(div(Math.imul(feeSats, ONE), Math.imul(HEAT_AT_SATS, ONE)), 0, ONE);
  const byValue = mulFast(clamp(div(Math.imul(btcHundredths, ONE), Math.imul(2500, ONE)), 0, ONE), 29491);
  return clamp(add(byFee, byValue), 0, ONE);
}
