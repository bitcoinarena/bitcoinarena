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
import { RESULTS_FOR_FINAL, provisionallyFinal, resultId } from './result.js';
import { roundId } from './contracts.js';
import { VOID, ENTRY_VOID, compareBytes, computePayoutTable } from './payout.js';

/**
 * Fields 0.11 lists that a signed final cannot supply, and the reason for each.
 *
 * Returned rather than left as blank columns: a column nobody filled looks the
 * same as a column somebody forgot, and the first is a decision while the
 * second is a bug.
 */
/**
 * THE THREE 0.11 FIELDS A SIGNED FINAL CANNOT SUPPLY, each with what WOULD
 * supply it and what stands in the way.
 *
 * A reason alone is only half an answer. "Not on a final" tells a caller not
 * to expect the column; it does not tell them whether anyone is coming for it,
 * which is the difference between a decision somebody owes and a task somebody
 * forgot. Each line below names the source and the blocker, so the absence can
 * be argued with rather than merely observed.
 *
 * NONE OF THE THREE IS FAKED FROM THE CLIENT. A board that guessed at any of
 * them would be showing a player something no node could reproduce, and the
 * whole point of this file is that two players comparing screens see the same
 * rows.
 */
export const NOT_ON_A_FINAL = [
  // The key IS on the row, so a client can render whatever it likes from it.
  // What is not settled is HOW: 0.12 says "clients MAY derive a friendly
  // pseudonym (brave-otter-4711)" and specifies no scheme. Two nodes with
  // different wordlists would show one player under two names, so a scheme is
  // a thing somebody chooses once - the BOND_MARKER and checkpoint class - and
  // writing a plausible wordlist here would settle it by accident.
  'pseudonym (0.12: "clients MAY derive a friendly pseudonym" - the player key '
  + 'is on the row and the SCHEME is unchosen; a wordlist picked here would '
  + 'settle it by accident, and two wordlists would name one player twice)',

  // The core carries cargo in its state, so a replay has it. A final does not,
  // and this board reads finals.
  'cargo statistics (not on a final; the core holds cargo in its state, so it '
  + 'comes from REPLAYING the transcript - the replay pool of M2.3, not a '
  + 'field anyone can add to a result)',

  // Marks are published during the run and ghosts are its pictures; both reach
  // a client through the daemon.
  'live run status (a final is after the run; it would come from marks and '
  + 'ghosts, which reach a client through the daemon - BLOCKED ON 22, the same '
  + 'dependency as putting this board on a screen)',
];

/**
 * THE ONE THING THAT DECIDES WHETHER A ROW APPEARS, AND THIS PACKAGE CANNOT
 * CHECK IT.
 *
 * `provisionallyFinal` counts `{ resultId, nodePubkey }` pairs against the
 * round's committee. It does not verify a signature, and `result.js` says why:
 * "this package carries no curve, so the caller passes what it has checked."
 * That boundary is right. What was wrong is that the BOARD did not say so.
 *
 * Five entries in an array were counted as five committee signatures, and the
 * answer came back looking exactly like a verified one. Every other door here
 * names its curve boundary - `resolveCensus` returns "advertisement signature
 * (no curve in this package)", `acceptAdvert` the same, `provesEquivocation`
 * takes its verify from the caller - and this was the one place that did not.
 * A caller who assembled `signedBy` without checking anything would have had
 * no way to tell from the answer.
 */
export const SIGNATURES_NOT_VERIFIED =
  'committee signatures (counted against the round\'s committee, not verified: '
  + 'no curve in this package, so a caller passes what it has checked)';

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

/**
 * `signaturesVerified` is the caller saying it has already checked them. It is
 * a claim about the caller's own work, not about the data, so it changes the
 * REPORT and nothing else: the same rows, the same order, the same amounts. A
 * caller that lies here has lied to itself.
 */
export function leaderboard(rows, {
  contract, needed = RESULTS_FOR_FINAL, payout, signaturesVerified = false,
} = {}) {
  if (!contract || !Array.isArray(contract.nodes) || !contract.nodes.length)
    return { ok: false, why: 'that round names no committee to check signatures against' };
  if (!Array.isArray(rows))
    return { ok: false, why: 'no results to build a board from' };

  // WHICH ROUND THIS BOARD IS OF, and the contract answers it - not a caller.
  //
  // Section 1: "All accepted players belong to the SAME logical round and
  // payout pool." A board is of one round or it is of nothing: hand it two
  // rounds' finals and it would interleave them into a single rank sequence,
  // and a player who came third of four would be shown seventh of eight
  // without a single forged signature. Nothing in the finality check would
  // notice, because a foreign round's results are perfectly well signed - by
  // a foreign committee.
  //
  // The id is COMPUTED from the contract, not read off a field a caller
  // fills. There is no `thisRound` argument for the same reason there is no
  // payout table argument: a number a caller picks is a number the operator
  // picks. If the contract cannot be hashed the board refuses to build,
  // because a board that cannot say which round it is of is worse than none.
  let round;
  try { round = roundId(contract); }
  catch (err) {
    return { ok: false, why: `that round contract cannot be hashed, so there is no round to check results against: ${err.message}` };
  }

  const committee = contract.nodes;
  const ranked = [];
  const unranked = [];
  const excluded = [];

  // ONE FINAL PER PLAYER. Keyed by the player, holding the result's id, so a
  // repeat can be told from a contradiction.
  const byPlayer = new Map();

  for (const row of rows) {
    const r = row && row.result;
    if (!r || !(r.playerPubkey instanceof Uint8Array)) {
      excluded.push({ why: 'that row carries no player result' });
      continue;
    }

    if (!(r.roundId instanceof Uint8Array) || compareBytes(r.roundId, round) !== 0) {
      excluded.push({
        playerPubkey: r.playerPubkey,
        why: 'that result is final for a different round than this contract',
      });
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

    // A PLAYER APPEARS ONCE, AND THE BOARD DOES NOT PICK BETWEEN CLAIMS.
    //
    // The same final handed in twice is a repeat: one row, and every rank
    // below it stays where it was. Two DIFFERENT finals for one player is not
    // a repeat - it is a committee contradicting itself, and 14 makes that a
    // conflict to be settled, not a presentation question. So the board shows
    // neither and names both: choosing the higher score would let whoever
    // obtained a second signature set decide a rank, and choosing the first
    // one handed over would let arrival order decide it, which is the fault
    // this whole file is built against.
    const rid = resultId(r);
    const key = hex(r.playerPubkey);
    const prior = byPlayer.get(key);
    if (prior) {
      if (compareBytes(prior.rid, rid) === 0) {
        excluded.push({
          playerPubkey: r.playerPubkey,
          why: 'that same final was handed in more than once',
        });
      } else {
        prior.conflict = true;
      }
      continue;
    }

    const entry = {
      playerPubkey: r.playerPubkey,
      outcome: r.outcome,
      score: r.score,
      signers: seen.signers,
    };
    byPlayer.set(key, { rid, entry, conflict: false });

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

  // The contradicted players come off, deterministically: the exclusions are
  // added in key order, so two nodes handed the same rows in different orders
  // report the same list and not merely the same rows.
  const conflicted = [...byPlayer.values()].filter((v) => v.conflict)
    .sort((a, b) => compareBytes(a.entry.playerPubkey, b.entry.playerPubkey));
  for (const v of conflicted) {
    const drop = (list) => {
      const i = list.indexOf(v.entry);
      if (i >= 0) list.splice(i, 1);
    };
    drop(ranked); drop(unranked);
    excluded.push({
      playerPubkey: v.entry.playerPubkey,
      why: 'two different results are final for that player, and the board is not the place to choose between them',
    });
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
    unchecked: signaturesVerified
      ? NOT_ON_A_FINAL
      : [SIGNATURES_NOT_VERIFIED, ...NOT_ON_A_FINAL],
  };
}
