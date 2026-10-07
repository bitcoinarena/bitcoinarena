// The load, ported from CargoBay.
//
// The sats aboard are the transaction's fee and go to the miner - they are not
// the player's pay, and the UI was wrong about that for a while. What a load
// buys the player is the cargo factor in the score, and the heat it attracts.

import { ONE, add, mulFast, div, clamp } from '../fixed.js';

const BED_LENGTH = 196608;      // 3.0 m
const COLUMNS = 2;
export const BED_ROOM = Math.imul(BED_LENGTH, COLUMNS) >> 16;   // in Q16.16 units

const HEAT_AT_SATS = 20000;
const BTC_AT_FULL = 2500;       // 25.00 BTC, in hundredths - where the whale term caps

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
  // CAPPED BEFORE THEY ARE SCALED, and that is not tidiness.
  //
  // `Math.imul(feeSats, ONE)` wraps at 32,768 sats. This rule had no caller
  // for the whole of its life, so nothing ever found it: a 40,000-sat load -
  // an ordinary one, twice what the rule calls full - scaled to -2,147,483,648
  // and clamped to ZERO, and the fattest loads in the game would have been the
  // ones the war ignored. Both terms are ratios that cap at one, so capping
  // the numerator first changes no answer that was ever right.
  const fee = clamp(feeSats | 0, 0, HEAT_AT_SATS);
  const btc = clamp(btcHundredths | 0, 0, BTC_AT_FULL);
  const byFee = div(Math.imul(fee, ONE), Math.imul(HEAT_AT_SATS, ONE));
  const byValue = mulFast(div(Math.imul(btc, ONE), Math.imul(BTC_AT_FULL, ONE)), 29491);
  return clamp(add(byFee, byValue), 0, ONE);
}
