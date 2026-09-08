// Committee selection: bond-weighted, linear, and decided in integers.

import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG, roleByte } from './constants.js';
import { compareEntries } from './census.js';
import { poolOfRole, GAME_VERIFY, SETTLEMENT } from './fee.js';

/**
 * HOW MANY SEATS THIS ROUND GIVES THE POOL A ROLE SERVES IN.
 *
 * 5A.7 sizes the two pools, not the four roles - "GAME/VERIFY: 7 slots,
 * threshold 5; SETTLEMENT: 7 slots, threshold 5" - so the mapping is the one
 * 22A already uses for the fee shares, imported rather than written twice: a
 * second copy of a protocol mapping is a second place for it to drift.
 *
 * A role with no pool has no committee, and that is answered rather than
 * silently given zero seats.
 */
export function slotsForRole(contract, role) {
  const pool = poolOfRole(role);
  if (pool === GAME_VERIFY) return contract.gameVerifySlots;
  if (pool === SETTLEMENT) return contract.settlementSlots;
  return undefined;
}

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
export function selectCommittee({ entries, contract, role, exclude }) {
  // EVERY NUMBER THAT DECIDES THE COMMITTEE COMES OFF THE CONTRACT.
  //
  // All three used to be arguments. Section 6 on the slot counts: "echoed for
  // readability; MUST equal genesis_parameters... A contract disagreeing with
  // the network it names is invalid, NOT A SMALLER COMMITTEE." Nobody had to
  // forge a census to shrink one - a smaller `slots` did it. And the seed
  // decides who wins the tickets, while `bondMin` normalises the weights, so a
  // caller free to choose either chose the committee as surely as the seed.
  const slots = slotsForRole(contract, role);
  if (!Number.isInteger(slots))
    throw new Error(`that round names no committee size for ${role}`);
  if (!(contract.committeeSeed instanceof Uint8Array))
    throw new Error('that round names no committee seed');
  if (typeof contract.bondMinSats !== 'bigint')
    throw new Error('that round names no bond floor to weigh against');
  const committeeSeed = contract.committeeSeed;
  const bondMin = contract.bondMinSats;

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
