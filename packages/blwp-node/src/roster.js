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
import { committeeSeedFromBeacon, beaconFromChain, beaconIsTheChains } from '../../protocol/src/beacon.js';
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

/**
 * AND WHERE THE BEACON COMES FROM, which is not here either.
 *
 * 5A.5's seed is `H(roots || round_id || round_randomness)` and the randomness
 * is the network's `randomness_source` - `bitcoin-block-hash` on every network
 * this build knows. A node given none seats nobody: "I have no beacon" and
 * "the committee is whatever the contract says" must never be the same answer,
 * because the second is the grinding attack.
 */
export const NO_BEACON = () => undefined;

export class Roster {
  constructor(round, { chainFor = NO_CHAIN_VIEW, randomnessFor = NO_BEACON } = {}) {
    this.round = round;
    this.chainFor = chainFor;
    this.randomnessFor = randomnessFor;
  }

  /**
   * THE SEED THIS ROUND IS SEATED WITH, from the beacon and never from the
   * contract's own bytes.
   *
   * The field is checked against it - a round naming a seed its beacon does
   * not produce is refused by name - and the seed handed to the lottery is the
   * BEACON'S, so even a caller that skipped the comparison could not seat from
   * chosen bytes.
   */
  seedFor(roundIdBytes, contract) {
    const given = this.randomnessFor({ contract, roundIdBytes });
    const randomness = given instanceof Uint8Array ? given : given && given.hash;
    if (!randomness)
      return {
        ok: false,
        why: 'this node has no beacon for that round, so it cannot say who the census seats',
      };
    // 27'S RULE FIRST, because it needs no chain. "Did this come after
    // committee_time" is the question every node can ask, and a beacon the
    // creator could have held is refused for that before anything else is
    // considered - a node with no chain view still refuses it.
    const seeded = committeeSeedFromBeacon(contract, {
      roundId: roundIdBytes, randomness, height: given && given.height, timeMs: given && given.timeMs,
    });
    if (!seeded.ok) return seeded;

    // AND THEN: IS IT THE BLOCK THIS NODE'S OWN CHAIN NAMES?
    //
    // `committeeSeedFromBeacon` can only ask whether the beacon came AFTER
    // committee_time - it is handed a height and a time and no chain. This
    // node HAS a chain, so it asks the other half: 5A.5 wants the FIRST block
    // after committee_time, and a later one is a block somebody chose. Without
    // this an operator hands their own node any late block and picks the
    // committee, which is the grinding attack with one extra step.
    //
    // WHEN THE VIEW CANNOT ANSWER, THE CHECK DOES NOT RUN AND SAYS SO. A census
    // view is a window chosen for the census height, not for the beacon: it may
    // begin after the block in question or be shorter than the eleven blocks a
    // median is taken over. Refusing a round because a window has the wrong
    // shape would refuse for something that is not about the beacon at all. So
    // the answer carries `checkedAgainstChain`, and a caller that needs the
    // check can see whether it happened rather than assume it did.
    const view = this.chainFor({ contract, roundIdBytes });
    let checkedAgainstChain = false;
    if (view && Array.isArray(view.blocks) && view.blocks.length) {
      const headers = { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight };
      const named = beaconFromChain(contract, headers);
      // A VIEW THAT CANNOT NAME THE BLOCK IS NOT A PASS.
      //
      // This used to skip the check and say so on the answer, and that was a
      // hole with a number: on the no-bitcoind path the census view was two
      // blocks and `checkedAgainstChain` came back FALSE while the round seated
      // anyway - so an operator handing a deliberately narrow view skipped the
      // one check that says the beacon is the chain's. A node that has a chain
      // and cannot answer with it refuses.
      //
      // A node with NO view at all is a different case and is left alone here:
      // it cannot derive a census either, so `censusFor` refuses it first, and
      // 27's rule above has already run without needing a chain.
      if (!named.ok) return named;
      const agrees = beaconIsTheChains(contract, {
        hash: randomness, height: given && given.height, timeMs: given && given.timeMs,
      }, headers);
      if (!agrees.ok) return agrees;
      checkedAgainstChain = true;
    }

    return { ...seeded, checkedAgainstChain };
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
   * EVERY SEAT THIS ROUND HAS, over the roles its contract names slots for.
   *
   * A contract carries one flat `nodes` list, so the seated set is the union
   * of the role committees - a node seated for either pool is seated.
   */
  seatsFor(roundIdBytes) {
    const seats = new Map();
    for (const role of ['game', 'settlement']) {
      const picked = this.committeeFor(roundIdBytes, role);
      if (!picked.ok) return picked;
      for (const e of picked.committee) seats.set(toHex(e.pubkey), e.pubkey);
    }
    return { ok: true, seats: [...seats.values()] };
  }

  /**
   * SEAT THE ROUND, and refuse one whose contract names anybody else.
   *
   * 26's ruling: the seated set from the chain census is the only list that
   * counts. `contract.nodes` is what a round's author wrote down, so it is
   * CHECKED against the seats - exactly, both ways - and a contract naming a
   * stranger, omitting a seated node, or being a different set altogether is
   * refused by name rather than rewritten or accepted on overlap.
   *
   * The seats are stored, so `takeReceipt` and the verdict read the census's
   * answer rather than each deciding for themselves.
   */
  seatRound(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'this node holds no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    const seated = this.seatsFor(roundIdBytes);
    if (!seated.ok) return seated;

    const named = Array.isArray(contract.nodes) ? contract.nodes : [];
    const have = new Set(seated.seats.map(toHex));
    const says = new Set(named.map(toHex));

    const strangers = [...says].filter((k) => !have.has(k));
    const missing = [...have].filter((k) => !says.has(k));
    if (strangers.length || missing.length)
      return {
        ok: false,
        why: `that round names ${named.length} committee ${named.length === 1 ? 'key' : 'keys'} and `
          + `the census seats ${seated.seats.length}: `
          + `${strangers.length} the chain did not seat`
          + `${strangers.length ? ` (${strangers[0].slice(0, 16)})` : ''}, `
          + `${missing.length} seated ${missing.length === 1 ? 'node' : 'nodes'} it does not name`
          + `${missing.length ? ` (${missing[0].slice(0, 16)})` : ''}`,
      };

    this.round.seat(roundIdBytes, seated.seats);
    return { ok: true, seats: seated.seats };
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

    // THE LOTTERY IS DRAWN ON THE BEACON'S SEED. Not on `contract.committeeSeed`:
    // that field is the author's claim about it, and 34 offline tries were
    // enough to make it seat a chosen pair.
    const seeded = this.seedFor(roundIdBytes, contract);
    if (!seeded.ok) return { ok: false, why: seeded.why, root: census.root };

    let committee;
    try {
      committee = selectCommittee({
        entries: census.entries, contract, role, committeeSeed: seeded.seed,
      });
    } catch (e) { return { ok: false, why: e.message, root: census.root }; }

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
