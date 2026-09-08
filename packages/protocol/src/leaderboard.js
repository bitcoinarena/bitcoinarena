// THE BOARD AFTER A ROUND, AND IT DECIDES NOTHING.
//
// 0.11: "Derived from signed final protocol results. It may show pseudonym,
// live run status, delivered/failed state, score, rank, cargo statistics and
// payout. THE LEADERBOARD IS PRESENTATION, NOT AUTHORITY."
//
// That last sentence is the whole design. Nothing here computes a payout,
// calls `computePayoutTable`, or invents an amount: section 20 makes the table
// `F(contract, membership, results)` and a second thing that produced numbers
// would be a second scoring path, which is what the core exists to prevent. A
// board is a way of LOOKING at results that are already signed.
//
// AND EVERY NODE MUST SHOW THE SAME ONE. "Identical inputs produce identical
// results on every machine" is not only about the simulation: two players
// comparing screens are comparing this, and a board whose order depended on
// which results arrived first would let a node put whoever it liked at the
// top without forging anything. So every comparison here ends at the player's
// key, which is intrinsic and cannot be chosen after the fact - the same tie
// discipline the census needed on the tip hash and interest management needed
// on the entry id.
import { RESULTS_FOR_FINAL, provisionallyFinal } from './result.js';
import { VOID, ENTRY_VOID, compareBytes, computePayoutTable } from './payout.js';

/**
 * Fields 0.11 lists that a signed final cannot supply, and the reason for each.
 *
 * Returned rather than left as blank columns: a column nobody filled looks the
 * same as a column somebody forgot, and the first is a decision while the
 * second is a bug.
 */
export const NOT_ON_A_FINAL = [
  'pseudonym (0.12: "clients MAY derive a friendly pseudonym" - a rendering of '
  + 'the player key, not a protocol field)',
  'cargo statistics (not carried on a signed final and not derivable from one)',
  'live run status (a final is after the run; live status would come from marks '
  + 'and ghosts, which is a different letter)',
];

/**
 * The board, from results the committee has actually stood behind.
 *
 * `rows` are `{ result, signedBy }`: the PlayerResult, and who signed it as
 * `{ resultId, nodePubkey }` - the shape `provisionallyFinal` already takes.
 *
 * THE COMMITTEE IS THE ROUND'S, off the contract's `nodes`, not a list the
 * caller brings. A caller who could choose the committee could choose which
 * results counted as final, and the board is the thing a player reads to find
 * out whether they won.
 *
 * A result nobody has signed five times does not appear. It is not ranked
 * last, not shown greyed: 13's threshold is what makes a result a result, and
 * a board that showed the others would be showing a node's opinion beside a
 * committee's decision as though they were the same kind of thing.
 */
/**
 * WHAT EACH PLAYER WAS PAID, AND THE BOARD DID NOT WORK IT OUT.
 *
 * Section 20 makes the table `F(contract, membership, results)`, and a second
 * thing that produced amounts would be a second scoring path. So the board is
 * not handed a table - it is handed the INPUTS and calls `computePayoutTable`,
 * the one implementation. A caller cannot pass a forged table because there is
 * no argument for one, which is the same shape as the core's missing ghost
 * parameter: the guarantee is the absence.
 *
 * AND THE INPUTS HAVE TO BE THIS ROUND'S. An entry claiming DELIVERED for a
 * player the committee marked FAILED is an input that would pay somebody for a
 * run they did not have, so every payout entry is checked against the final
 * the board already accepted: same outcome, same score, and no entry for a
 * player who has no final at all.
 *
 * A PLAYER THE TABLE DOES NOT LIST HAS NO AMOUNT FIELD. Not zero: zero is a
 * paid amount - the table lists everybody who was activated, and one of them
 * placing outside the paying ranks is paid nothing - and "paid nothing" must
 * stay distinguishable from "not in the table at all", which is what a
 * refunded player is.
 */
function payoutsFor(payout, finals) {
  if (!payout) return { ok: true, amounts: null };
  if (!Array.isArray(payout.entries))
    return { ok: false, why: 'that payout names no entries to compute a table from' };

  const byKey = new Map(finals.map((f) => [hex(f.playerPubkey), f]));
  for (const e of payout.entries) {
    if (!e || !(e.pubkey instanceof Uint8Array))
      return { ok: false, why: 'a payout entry names no player' };
    const final = byKey.get(hex(e.pubkey));
    if (!final)
      return {
        ok: false,
        why: 'that payout counts a player the committee has made no result final for',
      };
    if (e.outcome !== final.outcome)
      return {
        ok: false,
        why: `that payout says ${e.outcome} for a player whose final result is ${final.outcome}`,
      };
    if (e.score !== final.score)
      return {
        ok: false,
        why: `that payout scores a player ${e.score} where the final says ${final.score}`,
      };
  }

  let table;
  try { table = computePayoutTable(payout); }
  catch (err) { return { ok: false, why: `that payout cannot be computed: ${err.message}` }; }

  return { ok: true, amounts: new Map(table.table.map((r) => [hex(r.pubkey), r.amountMsat])) };
}

const hex = (b) => {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
};

export function leaderboard(rows, { contract, needed = RESULTS_FOR_FINAL, payout } = {}) {
  if (!contract || !Array.isArray(contract.nodes) || !contract.nodes.length)
    return { ok: false, why: 'that round names no committee to check signatures against' };
  if (!Array.isArray(rows))
    return { ok: false, why: 'no results to build a board from' };

  const committee = contract.nodes;
  const ranked = [];
  const unranked = [];
  const excluded = [];

  for (const row of rows) {
    const r = row && row.result;
    if (!r || !(r.playerPubkey instanceof Uint8Array)) {
      excluded.push({ why: 'that row carries no player result' });
      continue;
    }

    const seen = provisionallyFinal(row.signedBy || [], { committee, needed });
    if (!seen.final) {
      excluded.push({
        playerPubkey: r.playerPubkey,
        why: `the committee has not made that result final: ${seen.why || `${seen.signers} of ${needed}`}`,
      });
      continue;
    }

    const entry = {
      playerPubkey: r.playerPubkey,
      outcome: r.outcome,
      score: r.score,
      signers: seen.signers,
    };

    // A REFUND IS NOT A PLACE. Section 18: "VOID and ENTRY_VOID entries neither
    // contribute to nor draw from the pool" - so ranking them last would put a
    // player who was refunded below one who lost, and the board would be
    // saying something the money does not. They are shown, and they are shown
    // without a rank.
    //
    // FORFEIT DOES rank. `isRefund` covers VOID and ENTRY_VOID and not
    // FORFEIT, and `computePayoutTable` puts a forfeit's stake into the loser
    // pool: it played and lost, which is a place.
    if (entry.outcome === VOID || entry.outcome === ENTRY_VOID) unranked.push(entry);
    else ranked.push(entry);
  }

  // The amounts, from the round's own inputs through section 20's function.
  const paid = payoutsFor(payout, [...ranked, ...unranked]);
  if (!paid.ok) return { ok: false, why: paid.why };

  // Score descending, then the key. Never arrival, and never a comparison that
  // can return 0 for two different players: `Array.prototype.sort` is stable in
  // every engine now, but "stable" means it keeps the INPUT order, and the
  // input order is exactly what must not decide a rank.
  ranked.sort((a, b) => (b.score - a.score) || compareBytes(a.playerPubkey, b.playerPubkey));
  unranked.sort((a, b) => compareBytes(a.playerPubkey, b.playerPubkey));

  // PAYOUT IS A COLUMN, NOT A SORT KEY. The order was settled by the score and
  // the player key; adding money to it would let a table decide a place.
  const withPay = (e) => (paid.amounts && paid.amounts.has(hex(e.playerPubkey))
    ? { ...e, payoutMsat: paid.amounts.get(hex(e.playerPubkey)) }
    : { ...e });

  return {
    ok: true,
    rows: [
      ...ranked.map((e, i) => ({ ...withPay(e), rank: i + 1 })),
      ...unranked.map((e) => ({ ...withPay(e), rank: null })),
    ],
    ranked: ranked.length,
    excluded,
    unchecked: NOT_ON_A_FINAL,
  };
}
