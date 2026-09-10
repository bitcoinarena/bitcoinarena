// 22A: WHAT EACH NODE IS OWED, AND THE FACT THAT SOMEBODY COMPUTES IT.
//
// The fee was the one number in this protocol nobody recomputed. 5A.3 row 6
// decides WHETHER a node qualifies for a share; until this file, nothing said
// what the share IS - so a qualifying node could claim any amount and no
// predicate contradicted it. That is the shape row 3 had before
// `computePayoutTable` was wired into it.
//
// 22A gives the whole of it and leaves nothing to taste:
//
//   gross_round_volume = sum of stake of every financially activated entry
//   node_fee = 2.00% of gross_round_volume
//   1.00% -> GAME/VERIFY pool (7 slots)
//   1.00% -> SETTLEMENT pool (7 slots)
//   ...unearned shares are redistributed pro rata among the other eligible
//   nodes in the same role pool, keeping the total at 2%.
//   Remainders. Calculate in millisatoshis, floor each base share, and
//   distribute the remaining msat in ascending H(round_id || node_pubkey).
//
// MILLISATOSHI BIGINT THROUGHOUT, like every other money path here. The
// percentages are basis points and integer division; nothing is a float, and
// the remainder a floor leaves behind is handed out rather than kept.
import { Writer } from './encode.js';
// `fromHex` from hash.js and not a private copy. There was one here - the
// same loop without the odd-length check - and two of one decoder is two
// places for it to differ. It also made this file unbundleable beside
// hash.js, which is how it was found.
import { taggedHash, fromHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_FEE_CLAIM, TAG } from './constants.js';
import { roundId } from './contracts.js';
import { DELIVERED, FAILED, FORFEIT, isRefund, remainderOrder, netStakeMsat } from './payout.js';

/** 2.00%, and the 1.00% each pool takes of it. 22A fixes both. */
export const NODE_FEE_BPS = 200;
export const POOL_BPS = 100;

/** The two pools 22A pays, and the roles that sit in each. */
export const GAME_VERIFY = 'gameVerify';
export const SETTLEMENT = 'settlement';
export const POOLS = [GAME_VERIFY, SETTLEMENT];

/**
 * WHICH POOL A ROLE IS PAID FROM, and it is not a formality.
 *
 * 22A: "An operator selected for BOTH roles earns BOTH shares, because it
 * performs both services." So the two shares are separate money and a seat
 * held in each is owed each - a table keyed by pubkey alone merges them, and a
 * claim in one role is then measured against the sum of both, which is an
 * over-claim nobody can see. Measured while writing this: a settlement claim
 * from a node that sat on game/verify was judged against the game/verify
 * share and passed.
 *
 * `relay` is not paid by 22A: the fee is named for the two committees.
 */
export const POOL_OF_ROLE = { game: GAME_VERIFY, verify: GAME_VERIFY, settlement: SETTLEMENT };
export const poolOfRole = (role) => POOL_OF_ROLE[role] || null;

/** Seats are keyed by pool AND key, because the two shares are separate money. */
const seatKey = (pool, pubkey) => `${pool}:${hex(pubkey)}`;

/**
 * THE FEE BASE, 22A: "gross_round_volume = sum of stake of every financially
 * activated entry", and "ENTRY_VOID and VOID entries are excluded".
 *
 * The same set `computePayoutTable` calls `activated`, and deliberately the
 * same predicate rather than a second one: a refunded entry is money that
 * never moved, and charging a fee on it would be charging for a round the
 * player was refunded out of.
 */
export function grossVolumeMsat(entries) {
  for (const e of entries)
    if (typeof e.stakeMsat !== 'bigint')
      throw new Error('stakes must be BigInt millisatoshi');
  return entries
    .filter((e) => !isRefund(e.outcome))
    .reduce((sum, e) => sum + e.stakeMsat, 0n);
}

/**
 * WHAT EVERY SEAT IS OWED, AND WHAT NOBODY IS.
 *
 * `pools` names the seats of each pool - the committee, as selected - and
 * `eligible` is who among them qualified under 22A's availability rule, which
 * is 5A.3 row 6's question and is answered elsewhere.
 *
 * THE TWO POOLS SUM TO EXACTLY THE FEE. The second is the remainder of the
 * first rather than a second division, so a gross that does not divide by
 * 10000 cannot lose a millisatoshi between them.
 *
 * AN EMPTY POOL IS UNALLOCATED, NOT THE OPERATOR'S. 22A keeps the total at 2%
 * by redistributing inside a role pool, and with nobody eligible in one there
 * is no inside to redistribute to. The spec does not hand it anywhere, and the
 * one direction that cannot quietly become the operator's income is nowhere -
 * so it is returned named, and the caller may not mistake it for a share.
 *
 * `roundId` comes off the CONTRACT rather than being passed, so the order the
 * remainders go out in belongs to the round and not to whoever asks.
 */
export function nodeFeeTable({ contract, entries, pools, eligible }) {
  const gross = grossVolumeMsat(entries);
  const fee = (gross * BigInt(NODE_FEE_BPS)) / 10000n;
  const first = (gross * BigInt(POOL_BPS)) / 10000n;

  // The second pool is what is left of the fee, not a second division: two
  // floors of the same ragged number can lose a millisatoshi between them.
  const shareOf = { [GAME_VERIFY]: first, [SETTLEMENT]: fee - first };

  const id = roundId(contract);
  const seats = new Map();
  let unallocated = 0n;

  for (const pool of POOLS) {
    const amount = shareOf[pool];
    const inPool = (pools && pools[pool]) || [];
    const earning = inPool.filter((k) => eligible.has(hex(k)));

    if (!earning.length) { unallocated += amount; continue; }

    // Floor the base share, then hand the leftover out one millisatoshi at a
    // time in the round's own order - 22A's rule, and the one `payout.js`
    // already uses for the pool so there is one implementation of it.
    const each = amount / BigInt(earning.length);
    let left = amount - each * BigInt(earning.length);
    for (const k of earning) seats.set(seatKey(pool, k), (seats.get(seatKey(pool, k)) || 0n) + each);
    for (const e of remainderOrder(id, earning.map((pubkey) => ({ pubkey })))) {
      if (left <= 0n) break;
      seats.set(seatKey(pool, e.pubkey), seats.get(seatKey(pool, e.pubkey)) + 1n);
      left -= 1n;
    }
  }

  const paid = [...seats.values()].reduce((a, b) => a + b, 0n);
  if (paid + unallocated !== fee)
    throw new Error(`fee table broken: ${paid} paid and ${unallocated} unallocated of ${fee}`);

  return { gross, fee, pools: shareOf, seats, unallocated };
}

/**
 * What one seat is owed FOR ONE ROLE, or nothing at all.
 *
 * The role is required: 22A pays the two pools separately and a seat held in
 * both earns both, so "what is this node owed" has no single answer.
 */
export const feeOwed = (table, nodePubkey, role) => {
  const pool = poolOfRole(role);
  return pool ? (table.seats.get(seatKey(pool, nodePubkey)) || 0n) : 0n;
};

const hex = (bytes) => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/**
 * THE TABLE AS ONE HASH, so a proof can be bound to it.
 *
 * 5A.3B step 4 rests on a stranger being able to re-derive a proof later and
 * check it. An over-claim is measured against a table, so the proof has to
 * name WHICH table - otherwise the accuser recomputes from an eligibility set
 * that suits them and every honest claim is an over-claim.
 *
 * The gross and the fee are in it as well as the rows: a table that agreed on
 * every seat while disagreeing about what the round was worth would be a
 * different table with the same fingerprint.
 */
export function feeTableId(table) {
  const w = new Writer();
  w.u8(TYPE_FEE_CLAIM);
  w.u16(PROTOCOL_VERSION);
  w.u64(table.gross);
  w.u64(table.fee);
  w.u64(table.unallocated);
  const rows = [...table.seats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  w.vec(rows, (row, ww) => {
    // `pool:key`, so the same node's two shares are two rows and a table that
    // moved money between the pools is a different table.
    const [pool, key] = row[0].split(':');
    ww.u8(POOLS.indexOf(pool));
    ww.bytes32(fromHex(key));
    ww.u64(row[1]);
  });
  return taggedHash(TAG.feeTable, w.finish());
}

/**
 * WHAT ONE ENTRY OWES IN FEE: 2% OF THE WALLET COMMITMENT, TAKEN OUT OF IT.
 *
 * 22A, "Collection: inclusive in the stake (changed)": "'Play for 100' now
 * means 100 leaves the wallet, and the wallet dialog agrees with the button
 * that was pressed." `stakeMsat` is that commitment, the fee is 2% of it, and
 * `netStakeMsat` is what is left for the pool once the fee and the donation
 * have come out.
 *
 * RETRACTED (6e). This comment used to call Collection "the error" and charge
 * 18's older "on top of the stake", on the ground that the net reading turns
 * 22A's 61 x 100 example into 117.12 sat. It does not. 22A's fee base is
 * `gross_round_volume`, "(61 x 100, the wallet commitments)", so the fee is 2%
 * of 6,100 = 122 sat and it is the POOL that is net: 6,100 - 122 - 122 =
 * 5,856. 117.12 was 2% of the net stake, a base 22A never uses. Measured in
 * `inclusive.test.js`.
 *
 * THE RATE IS A CONSTANT AND NOT A CONTRACT FIELD. 22A calls it "2%,
 * identical for everyone", so one rate covers every entry of every round; a
 * field would let an operator price its own round's fee, which is the fault
 * contract fields exist to prevent rather than one to import.
 *
 * The same integer floor the table uses, so one rate is applied one way.
 */
export const entryFeeMsat = (stakeMsat) => {
  if (typeof stakeMsat !== 'bigint') throw new Error('a stake is BigInt millisatoshi');
  if (stakeMsat < 0n) throw new Error('a stake cannot be negative');
  return (stakeMsat * BigInt(NODE_FEE_BPS)) / 10000n;
};

/**
 * DOES THIS ENTRY'S FEE STAND?
 *
 * An entry whose `feeMsat` is not 2% of its own `stakeMsat` does not, and it
 * matters in both directions. Too little and the round collected less than the
 * table will owe its nodes. TOO MUCH AND THE EXCESS IS INCOME: the fee table
 * computes from the stakes, so a millisatoshi over is a millisatoshi the table
 * never allocates to anybody and that stays with whoever collected it.
 *
 * Answered rather than thrown for a malformed entry, like every other decision
 * in this package: a caller that asked whether an entry stands should be told,
 * not made to catch.
 */
export function feeMatchesEntry(entry) {
  // STRICT, AND ON PURPOSE. Every entry the door judges is decoded from signed
  // bytes, so its amounts are BigInt - a free seat is three zeros, not three
  // missing fields. Coercing a Number or a missing amount here would have
  // hidden the wiring fault that refused the Daily's free seat at 11:15 (the
  // door not yet passing the donation) instead of naming it.
  if (!entry || typeof entry.stakeMsat !== 'bigint' || typeof entry.feeMsat !== 'bigint')
    return { ok: false, why: 'an entry carries a BigInt millisatoshi stake and fee' };
  if (entry.stakeMsat < 0n || entry.feeMsat < 0n)
    return { ok: false, why: 'a stake and a fee cannot be negative' };

  const owed = entryFeeMsat(entry.stakeMsat);
  if (entry.feeMsat !== owed)
    return {
      ok: false,
      owed,
      why: entry.feeMsat > owed
        ? `that entry was charged ${entry.feeMsat} where 2% of ${entry.stakeMsat} is ${owed}: `
          + `the ${entry.feeMsat - owed} over is money no fee table allocates`
        : `that entry was charged ${entry.feeMsat} where 2% of ${entry.stakeMsat} is ${owed}`,
    };

  // AND THE DONATION COMES OUT OF THE SAME COMMITMENT, so together they cannot
  // come to more than it. Measured before 6e: a donation of 200000 msat on a
  // 100000 stake stood here, because nothing looked at the donation at all -
  // an entry promising the donation set twice what the player put up.
  let net;
  try { net = netStakeMsat(entry); }
  catch (e) { return { ok: false, owed, why: e.message }; }
  return { ok: true, owed, net, why: `${owed} is 2% of ${entry.stakeMsat}, and ${net} of it is staked` };
}
