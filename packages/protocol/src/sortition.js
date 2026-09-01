// Committee selection: bond-weighted, linear, and decided in integers.

import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG, roleByte } from './constants.js';
import { compareEntries } from './census.js';

/**
 * A node's ticket for a role. Deterministic, and unchooseable in advance
 * because the committee seed is not known when the bond is funded.
 */
export function ticketFor(committeeSeed, entry, role) {
  const w = new Writer();
  w.bytes32(committeeSeed);
  w.bytes32(entry.txid);
  w.u32(entry.vout);
  w.u8(roleByte(role));
  return bytesToBigInt(taggedHash(TAG.ticket, w.finish()));
}

/**
 * Selection weight: LINEAR in the bond, floored, never below one.
 *
 * A comment rather than a line of code, because square root looks like the
 * obvious anti-whale choice and somebody will try to reintroduce it. Under
 * sqrt, four nodes at 1x have total weight 4 against one node at 4x with
 * weight 2 - so splitting a bond DOUBLES a node's chances, which is the exact
 * opposite of what the anti-whale intent wanted.
 */
export function weightOf(bondSats, bondMin) {
  if (bondMin <= 0n) throw new Error('bondMin must be positive');
  const w = bondSats / bondMin;
  return w < 1n ? 1n : w;
}

/**
 * Selects `slots` entries for a role.
 *
 * The score is ticket/weight, and it is NEVER computed. Cross-multiplied
 * BigInts instead: a float comparison here is a consensus bug whose only
 * symptom is two nodes disagreeing when their scores are close, which is the
 * worst failure profile there is - rare, unreproducible, and load-dependent.
 */
export function selectCommittee({ entries, committeeSeed, role, slots, bondMin, exclude }) {
  const excluded = new Set((exclude || []).map((e) => outpointKey(e)));

  const scored = entries
    .filter((e) => e.roles.includes(role))
    .filter((e) => !excluded.has(outpointKey(e)))
    .map((e) => ({
      entry: e,
      ticket: ticketFor(committeeSeed, e, role),
      weight: weightOf(e.bondSats, bondMin),
    }));

  scored.sort((a, b) => {
    const left = a.ticket * b.weight;
    const right = b.ticket * a.weight;
    if (left < right) return -1;
    if (left > right) return 1;
    // A tie is astronomically unlikely and must still be decided the same way
    // everywhere, so it falls back to the census order.
    return compareEntries(a.entry, b.entry);
  });

  return scored.slice(0, slots).map((s) => s.entry);
}

export const outpointKey = (e) => {
  let s = '';
  for (let i = 0; i < 32; i++) s += e.txid[i].toString(16).padStart(2, '0');
  return s + ':' + e.vout;
};
