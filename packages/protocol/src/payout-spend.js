// WHAT THE POOL PAYS OUT, AND TO WHOM, AS OUTPUTS.
//
// §20: "PayoutTable = F(RoundContract, Membership, FinalResults). Deterministic.
// Nodes sign the payout-table hash; 5-of-7 matching signatures make it final."
// `computePayoutTable` has computed that table since letter 20 and
// `encodePayoutTable` has had the bytes since; what was missing is anything
// that turns a row into a satoshi.
//
// A ROW IS NOT AN AMOUNT TO PAY. The table gives each qualifier their own stake
// back PLUS their winnings, because that is the whole of what they end the
// round holding. But their own stake never entered the pool - it came back over
// Lightning when the hold was cancelled - so paying the row would pay it twice,
// once by cancel and once out of other players' money. What the pool owes is
// the part ABOVE the stake, and the sum of those is exactly the pool.
// `holdSettlement` already asserts that equality and throws when it fails; this
// file computes the same difference rather than a second opinion of it.
//
// AND MILLISATOSHI DO NOT FIT ON A CHAIN. A row is msat and an output is sats,
// so every row is floored and what the flooring leaves behind, plus whatever
// the pool holds above the table, is the miner's fee. NOBODY HERE KEEPS IT:
// there is no change output, so an operator cannot take the remainder by
// building a transaction that pays itself the difference.
import { FIELD } from './shares.js';
import { netStakeMsat } from './payout.js';

/** BIP-341 P2TR: OP_1, a 32-byte push, the key. */
export const P2TR_BYTES = 34;

/**
 * THE RELAY FLOOR, MEASURED RATHER THAN DERIVED.
 *
 * A default bitcoind refuses a P2TR output below this and takes it at this:
 * 329 came back "Transaction amount too small" and 330 was accepted, on a
 * node whose `minrelaytxfee` is 0.00000100 BTC/kvB. An arithmetic derivation
 * from the dust-relay formula gave 796 and was WRONG - the node's own boundary
 * is the number, which is why this is a default a caller overrides with what
 * their chain said rather than a constant this file believes in.
 *
 * It is policy, not consensus: a miner may include a smaller output and a
 * different node may relay one. That is exactly why a row below it is not
 * discarded here - see `payoutOutputs`.
 */
export const DUST_SATS = 330n;

export const payToKey = (pubkey) => {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32)
    throw new Error('a payout pays to a 32-byte x-only key');
  const out = new Uint8Array(P2TR_BYTES);
  out[0] = 0x51;
  out[1] = 0x20;
  out.set(pubkey, 2);
  return out;
};

/**
 * WHAT THE POOL OWES EACH PLAYER: the row, less the NET stake that came back on
 * its own when the hold was cancelled. Rows that owe nothing are dropped rather
 * than paid zero.
 *
 * `stakes` are the entries' own three numbers - stake, fee, donation - and
 * `netStakeMsat` takes the difference, because the hold held the net (22A,
 * 23.5). Subtracting the commitment instead would short every winner by their
 * own fee and donation, and leave that much in a pool nobody is owed it from.
 */
export function winnings({ table, stakes }) {
  if (!Array.isArray(table)) return { ok: false, why: 'that is not a payout table' };
  const byKey = new Map();
  for (const s of stakes) {
    let held;
    try { held = netStakeMsat(s); } catch (e) { return { ok: false, why: e.message }; }
    byKey.set(hex(s.pubkey), held);
  }
  const rows = [];
  let owed = 0n;
  for (const row of table) {
    const stake = byKey.get(hex(row.pubkey));
    if (stake === undefined)
      return { ok: false, why: `the table pays a key this round never seated: ${hex(row.pubkey).slice(0, 16)}` };
    const msat = row.amountMsat > stake ? row.amountMsat - stake : 0n;
    if (msat > 0n) { rows.push({ pubkey: row.pubkey, msat }); owed += msat; }
  }
  return { ok: true, rows, owedMsat: owed };
}

/**
 * THE OUTPUTS OF ONE PAYOUT, AND THE ROWS THAT COULD NOT BE ONE.
 *
 * A ROW BELOW THE RELAY FLOOR IS NOT AN OUTPUT AND NOT A LOSS. It used to
 * refuse the whole payout, which was right about the row and wrong about the
 * round: measured, one player owed 100 sats stopped a player owed 5000 from
 * being paid at all. A single small winner should not hold everybody else's
 * money in the pool.
 *
 * So the floor is PER ROW. Rows at or above it are paid; rows below it are
 * left OWED, named and returned, and the caller writes that debt down. Three
 * things are deliberately not done with those sats:
 *
 *   not bumped to the floor   that would pay a player out of other players'
 *                             winnings, which the table did not say
 *   not folded into the fee   the miner is not who the round owes
 *   not dropped               dropping is the operator keeping money a player
 *                             had no part in losing
 *
 * They stay in the pool with the debt recorded, and the round is not finished
 * while they are there. Whether the answer is a balance that accumulates
 * across rounds or a Lightning payout is a policy this file does not invent.
 */
export function payoutOutputs({ rows, poolSats, dustSats = DUST_SATS, feeSats }) {
  if (!Array.isArray(rows) || !rows.length)
    return { ok: false, why: 'that round owes nobody anything, so there is nothing to spend' };
  if (typeof poolSats !== 'bigint' || poolSats <= 0n)
    return { ok: false, why: 'a payout spends a pool output, and that is not one' };

  const outputs = [];
  const owed = [];
  let paid = 0n;
  let owedSats = 0n;
  for (const row of rows) {
    const sats = row.msat / 1000n;
    if (sats < dustSats) {
      owed.push({ pubkey: row.pubkey, msat: row.msat, sats });
      owedSats += sats;
      continue;
    }
    outputs.push({ value: sats, script: payToKey(row.pubkey) });
    paid += sats;
  }

  // A ROUND WHERE NOBODY CLEARS THE FLOOR SPENDS NOTHING. There is no
  // transaction to make, and the debt is the whole of what happened.
  if (!outputs.length)
    return {
      ok: false, owed, owedSats,
      why: `every one of the ${owed.length} player(s) this round owes is under ${dustSats} sats, `
        + 'so there is no output to make: the sats stay in the pool and the debt stands',
    };

  const left = poolSats - paid;
  if (left < 0n)
    return { ok: false, why: `the table owes ${paid} sats and the pool holds ${poolSats}` };
  if (typeof feeSats === 'bigint' && left < feeSats)
    return { ok: false, why: `${left} sats are left for a fee of ${feeSats}` };

  // NO CHANGE OUTPUT, ON PURPOSE. Whatever the flooring and the pool's own
  // rounding leave over goes to the miner, because the alternative is an
  // output an operator chooses the destination of.
  //
  // THE OWED ROWS ARE PART OF THE ANSWER, not a footnote: a caller that
  // ignored them would mark a round paid while somebody is still owed.
  return { ok: true, outputs, paidSats: paid, feeSats: left, owed, owedSats };
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A row's key has to be a key, which is what makes it a destination. */
export const payableKey = (pubkey) => {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) return false;
  const v = BigInt('0x' + hex(pubkey));
  return v > 0n && v < FIELD;
};
