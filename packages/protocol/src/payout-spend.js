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

/** BIP-341 P2TR: OP_1, a 32-byte push, the key. */
export const P2TR_BYTES = 34;

/**
 * THE RELAY FLOOR, MEASURED RATHER THAN LOOKED UP.
 *
 * A default bitcoind refuses a P2TR output below this: 100 and 200 sats came
 * back "Transaction amount too small" and 330 was accepted. It is policy and
 * not consensus, which is exactly why it is named here as a number a caller
 * can pass rather than a constant this file believes in.
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
 * WHAT THE POOL OWES EACH PLAYER: the row, less the stake that came back on
 * its own. Rows that owe nothing are dropped rather than paid zero.
 */
export function winnings({ table, stakes }) {
  if (!Array.isArray(table)) return { ok: false, why: 'that is not a payout table' };
  const byKey = new Map(stakes.map((s) => [hex(s.pubkey), s.stakeMsat]));
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
 * THE OUTPUTS OF ONE PAYOUT, or a refusal that says which player cannot be
 * paid and why.
 *
 * A ROW BELOW THE RELAY FLOOR IS A REFUSAL AND NOT A ROUNDING. At the fixture
 * stake of 100000 msat - 100 sats - a whole round's pool is 200 or 300 sats
 * and no output clears 330, so a per-round on-chain payout is not something
 * this code declines to do, it is something a Bitcoin node will not relay.
 * Silently dropping such a row would keep the money in the pool, which is the
 * operator profiting from a limit the player had no part in.
 */
export function payoutOutputs({ rows, poolSats, dustSats = DUST_SATS, feeSats }) {
  if (!Array.isArray(rows) || !rows.length)
    return { ok: false, why: 'that round owes nobody anything, so there is nothing to spend' };
  if (typeof poolSats !== 'bigint' || poolSats <= 0n)
    return { ok: false, why: 'a payout spends a pool output, and that is not one' };

  const outputs = [];
  let paid = 0n;
  for (const row of rows) {
    const sats = row.msat / 1000n;
    if (sats < dustSats)
      return {
        ok: false,
        why: `${hex(row.pubkey).slice(0, 16)} is owed ${sats} sats and a node will not relay `
          + `an output below ${dustSats}: this round cannot be paid on chain`,
      };
    outputs.push({ value: sats, script: payToKey(row.pubkey) });
    paid += sats;
  }

  const left = poolSats - paid;
  if (left < 0n)
    return { ok: false, why: `the table owes ${paid} sats and the pool holds ${poolSats}` };
  if (typeof feeSats === 'bigint' && left < feeSats)
    return { ok: false, why: `${left} sats are left for a fee of ${feeSats}` };

  // NO CHANGE OUTPUT, ON PURPOSE. Whatever the flooring and the pool's own
  // rounding leave over goes to the miner, because the alternative is an
  // output an operator chooses the destination of.
  return { ok: true, outputs, paidSats: paid, feeSats: left };
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A row's key has to be a key, which is what makes it a destination. */
export const payableKey = (pubkey) => {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) return false;
  const v = BigInt('0x' + hex(pubkey));
  return v > 0n && v < FIELD;
};
