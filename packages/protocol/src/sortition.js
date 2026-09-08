// Committee selection: bond-weighted, linear, and decided in integers.

import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG, roleByte } from './constants.js';
import { compareEntries, meetsCensusMinimum } from './census.js';
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
export function selectCommittee({ entries, contract, role, exclude, committeeSeed }) {
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
  // THE SEED IS THE BEACON'S, AND IT IS AN ARGUMENT.
  //
  // It used to be read off `contract.committeeSeed` - thirty-two bytes the
  // round's AUTHOR wrote - so the lottery was a function of a value the
  // creator chose. Measured on a fixed census of eight bonded nodes with two
  // slots: 34 offline candidate seeds were enough to seat a chosen pair, and
  // since the seated set became the only trusted list that is the whole
  // committee. That is v4.4's grinding attack, which 5A.5 exists to close:
  //
  //   committee_seed = H(census_root_gv || census_root_settle
  //                      || round_id || round_randomness)
  //
  // and the spec's Round Contract carries `randomness_rule`,
  // `randomness_fallback`, `committee_time` and `entry_open_time` - and NO
  // committee seed, because a contract cannot name one: `round_id` hashes the
  // contract, so a contract carrying the seed derived from its own id has no
  // fixed point. Measured, six iterations, never equal.
  //
  // So the caller brings the seed its beacon produced. No fallback to the
  // field: a caller with no beacon gets a refusal, because "I have no
  // randomness" and "the committee is whatever the contract says" must never
  // be the same answer.
  if (!(committeeSeed instanceof Uint8Array) || committeeSeed.length !== 32)
    throw new Error('a committee is drawn on the seed its beacon produced, not on one a contract names');
  // A POSITIVE FLOOR, because the weight is bond/floor and a floor of zero is
  // not a small floor - it is a division by zero, and `weightOf` threw from
  // underneath here rather than this answering. It is also the thing 5A.3
  // warns about: a floor of nothing makes identity free, "the flaw that made
  // v4.4 unsafe".
  if (typeof contract.bondMinSats !== 'bigint' || contract.bondMinSats <= 0n)
    throw new Error('that round names no positive bond floor to weigh against');
  const bondMin = contract.bondMinSats;

  // AND THE CENSUS HAS TO BE BIG ENOUGH TO HOLD A ROUND AT ALL.
  //
  // Without this the function ended in `slice(0, slots)`, so a census with one
  // eligible node and a contract naming two slots gave back a COMMITTEE OF
  // ONE - silently, with no refusal anywhere - which is the thing section 13
  // exists to prevent arriving through the front door. `census_min_nodes` is
  // the network's own answer to "too small", and on all three networks it is
  // at least the slot count, so meeting it also means there are enough nodes
  // to fill the seats.
  //
  // BEFORE EXCLUSIONS, on purpose: `exclude` is for a re-draw, and excluding a
  // node does not unbond it. What is measured here is the census, not the
  // attempt.
  const enough = meetsCensusMinimum(entries, contract, role);
  if (!enough.ok) throw new Error(enough.why);

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
