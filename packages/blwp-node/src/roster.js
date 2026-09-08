// WHO MAY HOLD THIS ROUND: the daemon's own answer, from the chain.
//
// Everything letter 15 built was library code with no caller. Measured at the
// start of this slice: not one file under any `src/` called `scanCensus`,
// `resolveCensus`, `deriveCensus` or `commitCensus`, so a node could serve
// rounds without ever asking Bitcoin who was bonded - the census was a thing
// the tests did.
//
// This is the caller, and it is the ONLY one. Eligibility is not re-decided
// here: this fetches a chain view, hands it to `deriveCensus` with the curve
// the census needs, and hands what comes back to `selectCommittee`. Every rule
// - the marker, the template, the floor, the roles, the version, spentness,
// depth, and the network's minimum census - lives where it already lived. A
// second implementation of any of them here is exactly the divergence 5A.2
// exists to prevent, and the guard test in `round.test.js` counts the files
// that reach the census the same way it counts the files that reach the core.
import { deriveCensus } from '../../protocol/src/census.js';
import { selectCommittee } from '../../protocol/src/sortition.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { networkOf } from '../../protocol/src/constants.js';
import { toHex } from '../../protocol/src/hash.js';
import { bondSetFor } from './curve.js';

/**
 * WHERE THE BLOCKS COME FROM, AND THEY ARE NOT INVENTED HERE.
 *
 * The same shape as `verify.js`'s randomness: a node given no chain view says
 * so and holds no round, rather than deriving a census from what it happens to
 * remember. 5A.2 makes the census a function of Bitcoin, and a function of
 * something else is a different census - the divergence the whole section
 * exists to remove.
 */
export const NO_CHAIN_VIEW = () => undefined;

export class Roster {
  constructor(round, { chainFor = NO_CHAIN_VIEW } = {}) {
    this.round = round;
    this.chainFor = chainFor;
  }

  /**
   * The census of a round this node holds, or the reason there is none.
   *
   * The advertisement bodies are resolved OUT OF THE SAME BLOCKS: 5A.2 puts
   * the body in the witness of the funding transaction, so a node holding the
   * chain needs nobody to serve it one, and a peer offering a different body
   * for the same outpoint has nothing to offer.
   */
  censusFor(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'this node holds no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    const network = contract.networkId ? networkOf(contract.networkId) : null;
    if (network === null)
      return { ok: false, why: 'that round names a network this build has no genesis for' };

    const view = this.chainFor({ contract, roundIdBytes });
    if (!view || !Array.isArray(view.blocks))
      return {
        ok: false,
        why: 'this node has no chain view for that round, so it cannot say who is bonded',
      };

    const byTxid = new Map();
    for (const block of view.blocks) {
      for (const raw of block.transactions || []) {
        try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ }
      }
    }

    const census = deriveCensus(view, {
      contract,
      bond: bondSetFor(network),
      resolve: (e) => {
        const raw = byTxid.get(toHex(e.txid));
        return raw ? { transaction: raw } : null;
      },
    });
    if (!census.ok) return census;

    // AND IT HAS TO BE THIS ROUND'S CENSUS.
    //
    // Every contract names a `censusRoot`, and on this path nothing compared
    // it with what the chain actually gives. A round could name any
    // thirty-two bytes, and this node would derive a different census, seat a
    // committee out of it, and serve that - which is the divergence 5A.2
    // exists to remove, arriving from the round's own header. The spec is
    // blunt: a round whose census root is not the one its census derives to
    // "IS INVALID and no honest node will issue receipts against it".
    //
    // The comparison is against the root DERIVED HERE, from blocks, at the
    // contract's own height - not against a list anybody presented, which is
    // what `censusRootMatchesRound` is for when somebody else brings entries.
    if (!(contract.censusRoot instanceof Uint8Array) || contract.censusRoot.length !== 32)
      return { ok: false, why: 'that round names no census root to check against the chain' };
    if (!census.root.every((b, i) => b === contract.censusRoot[i]))
      return {
        ok: false,
        why: `that round names census root ${toHex(contract.censusRoot).slice(0, 16)} and the `
          + `chain gives ${toHex(census.root).slice(0, 16)} at height ${contract.censusHeight}`,
        root: census.root,
      };

    return census;
  }

  /**
   * The committee for a role, or the reason this round cannot be held.
   *
   * `selectCommittee` is what refuses a census smaller than the network's
   * minimum - a caller that pre-checked it here would be the second place that
   * rule lived, and the two would drift.
   */
  committeeFor(roundIdBytes, role) {
    const census = this.censusFor(roundIdBytes);
    if (!census.ok) return census;

    const row = this.round.get(roundIdBytes);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    let committee;
    try { committee = selectCommittee({ entries: census.entries, contract, role }); }
    catch (e) { return { ok: false, why: e.message, root: census.root }; }

    return {
      ok: true,
      role,
      committee,
      root: census.root,
      eligible: census.entries.length,
      excluded: census.excluded,
      unchecked: census.unchecked,
    };
  }
}
