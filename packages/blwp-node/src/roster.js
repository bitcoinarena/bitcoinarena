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
import { merkleBranchOf } from '../../protocol/src/chain.js';
import { networkOf } from '../../protocol/src/constants.js';
import { toHex } from '../../protocol/src/hash.js';
import { timed } from './slow.js';
import { committeeSeedFromBeacon, beaconFromChain, beaconIsTheChains } from '../../protocol/src/beacon.js';
import { findPublication, publicationIsBeforeBeacon } from '../../protocol/src/publication.js';
import { findSeriesPublication } from '../../protocol/src/series.js';
import { isOldTestnet4Id, isOldTestnet4Series, OLD_TESTNET4_SERIES_CENSUS_FROM } from '../../protocol/src/old-series.js';
import { bondSetFor } from './curve.js';
import { schnorr } from '@noble/curves/secp256k1.js';

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
 * this build knows. A node given none assigns nobody: "I have no beacon" and
 * "the committee is whatever the contract says" must never be the same answer,
 * because the second is the grinding attack.
 */
export const NO_BEACON = () => undefined;

/**
 * WHERE THE OTHER SIGNER NODES OF A COMMITTEE ANSWER, off their own advertisements.
 *
 * A committee is keys; a key is not an address. The census entry of each signer node
 * carries the signed advertisement from its bond, and its `endpoint` is where
 * that signer node says it answers - the socket form (`ws://`), turned into the HTTP
 * base the doors are on. This node is never its own peer, and a signer node that
 * advertised nowhere is left out rather than guessed at. One rule, used by
 * the payout path and the close alike.
 */
export function endpointsOf(committee, selfPubkey) {
  const self = selfPubkey ? toHex(selfPubkey) : null;
  const found = new Set();
  for (const e of committee || []) {
    if (!e || !e.advert || !e.advert.endpoint) continue;
    if (self && toHex(e.pubkey) === self) continue;
    found.add(String(e.advert.endpoint).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''));
  }
  return [...found];
}

/** THE ONE REFUSAL A NODE THAT READS NO CHAIN GIVES FOR A ROUND'S CENSUS - and POST /round's for a paying round (RULED 2026-09-25). */
export const NO_CHAIN_VIEW_WHY = 'this node has no chain view for that round, so it cannot say who is bonded';

const whereOf = new WeakMap();                 // chain view -> its txid index (guardianBondsFor)

export class Roster {
  constructor(round, { chainFor = NO_CHAIN_VIEW, randomnessFor = NO_BEACON } = {}) {
    this.round = round;
    this.chainFor = chainFor;
    this.randomnessFor = randomnessFor;
    // A CENSUS DERIVED ONCE, NOT ON EVERY ASK (the owner 2026-09-17 19:15, the ghost lag). Deriving one parses every
    // transaction of every block in the round's view, and the payout's `gather` asks for it on the finality cadence:
    // measured live, `payout peersOf` held the event loop that pushes a pictured truck 142-209 ms, every time, for an
    // answer that cannot change. A census is fixed at the round's own `censusHeight` - blocks mined above it are not
    // in it - so it is kept per round and per view start, and only when it matched the root the round names.
    this.censuses = new Map();
    this.chainChecks = new Map();                // series or round : beacon : view extent -> the chain check's answer
    // AND THE SEED AND THE COMMITTEE THE SAME WAY, per round and per view.
    this.seeds = new Map();
    this.committees = new Map();
  }

  /** How many derived censuses are kept: a round is asked about while it settles, and then never again. */
  static CENSUS_KEPT = 64;
  // PER-ROUND ANSWERS (a seed, a committee) FOR A SERIES' WORTH OF ROUNDS (the owner 2026-09-30: ~440 listed rounds of
  // series 3cfbe516 missed a 64-entry cache on every listing and were drawn again each time).
  static PER_ROUND_KEPT = 4096;

  /**
   * THE SEED THIS ROUND'S SIGNER NODES ARE ASSIGNED WITH, from the beacon and never from the
   * contract's own bytes.
   *
   * The field is checked against it - a round naming a seed its beacon does
   * not produce is refused by name - and the seed handed to the lottery is the
   * BEACON'S, so even a caller that skipped the comparison could not assign from
   * chosen bytes.
   */
  /**
   * THE SEED, CHECKED AGAINST THE CHAIN ONCE PER VIEW (the owner 2026-09-17 19:15, the ghost lag).
   *
   * A V8 profile of a live signer node named this path: `peersOf -> peersFor -> committeeFor -> seedFor ->
   * beaconFromChain / beaconIsTheChains -> chainWork -> meetsTarget -> blockHashOf -> hash256`, 39.8 s of a 417 s
   * window, under `carryReceipts` (31.3 s) and the finality tick (28.3 s) - and `carryReceipts` asks `peersOf` twice
   * per peer, per entry, at every close and every retry. Every ask re-hashed the round's whole view and re-checked its
   * proof of work. The work itself is not skipped: it runs when the view is new and when a header arrives, and the key
   * says so - a round it has not seen, or a view of a different length, misses and rebuilds. Only a pass is kept.
   */
  seedFor(roundIdBytes, contract) {
    const view = this.chainFor({ contract, roundIdBytes });
    const kept = view && Array.isArray(view.blocks)
      ? `${toHex(roundIdBytes)}:${view.firstHeight}:${view.blocks.length}` : null;
    if (kept && this.seeds.has(kept)) return this.seeds.get(kept);
    // TIMED WHERE THE PROFILE POINTED: this is the chain check - every header hashed, its proof of work read - and it
    // runs when the view is new or a header has arrived, never twice for the same one.
    const answer = timed(`committee chain check ${toHex(roundIdBytes).slice(0, 8)}`,
      () => this.#seedFor(roundIdBytes, contract, view), { over: 20 });
    if (kept && answer.ok) {
      this.seeds.set(kept, answer);
      if (this.seeds.size > Roster.PER_ROUND_KEPT) this.seeds.delete(this.seeds.keys().next().value);
    }
    return answer;
  }

  #seedFor(roundIdBytes, contract, viewGiven) {
    const given = this.randomnessFor({ contract, roundIdBytes });
    const randomness = given instanceof Uint8Array ? given : given && given.hash;
    if (!randomness)
      return {
        ok: false,
        why: 'this node has no beacon for that round, so it cannot say who the census assigns',
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
    const view = viewGiven;
    if (view && view.pending)
      return { ok: false, why: 'this node is still reading its chain view for that round' };
    let checkedAgainstChain = false;
    // THE CHAIN CHECK ONCE PER SERIES AND VIEW (the owner 2026-09-30, measured on testnet4): the beacon's block, its proof of
    // work and the series' publication are the same question for every round of a series - one committee_time, one
    // depth, one randomness, one publication - and at ~220 ms a round, past a 64-entry cache, ~484 rounds held GET
    // /rounds past 90 s. Kept by series (or round), randomness and the view's extent; a new header asks again.
    const chainKey = view && Array.isArray(view.blocks) && view.blocks.length
      ? `${contract.seriesId instanceof Uint8Array ? `series:${toHex(contract.seriesId)}` : toHex(roundIdBytes)}:${contract.committeeTimeMs}:`
        + `${contract.censusConfirmations}:${toHex(randomness)}:${view.firstHeight}:${view.blocks.length}` : null;
    if (chainKey && this.chainChecks.has(chainKey)) {
      const had = this.chainChecks.get(chainKey);
      return had.ok ? { ...seeded, checkedAgainstChain: true } : had;
    }
    const checked = this.#chainCheck(roundIdBytes, contract, view, randomness, given);
    if (chainKey) {
      this.chainChecks.set(chainKey, checked);
      if (this.chainChecks.size > Roster.CENSUS_KEPT) this.chainChecks.delete(this.chainChecks.keys().next().value);
    }
    if (!checked.ok) return checked;
    checkedAgainstChain = checked.checked;
    return { ...seeded, checkedAgainstChain };
  }

  #chainCheck(roundIdBytes, contract, view, randomness, given) {
    let checkedAgainstChain = false;
    if (view && Array.isArray(view.blocks) && view.blocks.length) {
      const headers = { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight };
      const named = beaconFromChain(contract, headers);
      // A VIEW THAT CANNOT NAME THE BLOCK IS NOT A PASS.
      //
      // This used to skip the check and say so on the answer, and that was a
      // hole with a number: on the no-bitcoind path the census view was two
      // blocks and `checkedAgainstChain` came back FALSE while the round joined
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

      // AND THE ROUND WAS ON THE CHAIN BEFORE THAT BLOCK (§5A.5, v4.6.2, P1).
      // "A round with no publication, or one confirmed at or after the beacon
      // block, is invalid and gets no entry receipts." Without this a creator
      // publishes many candidate rounds for free, waits for the beacon, and
      // promotes the one whose committee is his. Found in this node's own
      // view, so the height is the chain's and no txid is taken on trust.
      // A SERIES ROUND IS PUBLISHED BY ITS SERIES' PUBLICATION ("BLW" SERIES series_id), which must confirm strictly below
      // the beacon block as a round's own must (measured 2026-09-30: every round of series 3cfbe516 was refused here, "there
      // is no publication transaction to read", because only a round's own publication was looked for).
      // A FREE ROUND IS NOT POSTED ON THE CHAIN IN ADVANCE (the owner 2026-10-01 15:25, HARD): it moves no money, so there is
      // no committee worth grinding for; it is still multiplayer - its players join one round, its committee replays it.
      if (BigInt(contract.stakeMsat) === 0n) {
        // nothing to find: the free round is checked against the chain as every round is above, its census and beacon
      } else if (contract.seriesId instanceof Uint8Array) {
        const series = findSeriesPublication(view, contract.seriesId);
        if (!series) return { ok: false, why: `this node's chain view holds no publication of series ${toHex(contract.seriesId).slice(0, 16)}` };
        if (!(series.height < named.height))
          return { ok: false, why: `series ${toHex(contract.seriesId).slice(0, 16)} was published at ${series.height}, not below its beacon block ${named.height}` };
      } else {
        const published = findPublication(view, roundIdBytes);
        const before = publicationIsBeforeBeacon({
          roundId: roundIdBytes, tx: published && published.tx,
          txHeight: published ? published.height : undefined, beaconHeight: named.height,
        });
        if (!before.ok) return before;
      }
      checkedAgainstChain = true;
    }
    return { ok: true, checked: checkedAgainstChain };
  }

  /**
   * The census of a round this node holds, or the reason there is none.
   *
   * The advertisement bodies are resolved OUT OF THE SAME BLOCKS: 5A.2 puts
   * the body in the witness of the funding transaction, so a node holding the
   * chain needs nobody to serve it one, and a peer offering a different body
   * for the same outpoint has nothing to offer.
   */
  /**
   * THE CENSUS AT A HEIGHT SOMEBODY ELSE NAMED (§5A.3, ruled 2026-09-22).
   *
   * A slash is paid to "the active census nodes at the slashing height", and that height is one the
   * ARBITRATION SET names - at or below the tip when they sign, at or above the round's own
   * `census_height`. Same view, same bond set, same derivation; only the height moves, and the node
   * never picks it.
   *
   * AND THE ROUND'S CENSUS ROOT IS NOT CHECKED AGAINST IT, which is the whole reason this is not one
   * line calling `censusFor`. That check is what makes a census THIS ROUND'S: the contract commits to
   * one root, at one height, and a derivation that gives another is a round no honest node serves.
   * At any other height the chain is SUPPOSED to give another root - bonds funded after the round
   * opened are in it, bonds spent since are out - so reusing the check turns every slashing height
   * above `census_height` into "that round names census root X and the chain gives Y", which is the
   * measured behaviour of the first version of this method and is not a divergence at all. The set
   * returned here is therefore a statement about the chain at a height, not about the round, and the
   * height it was read at travels with it so no caller can mistake it for the round's own.
   */
  censusAtHeight(roundIdBytes, height) {
    if (!Number.isInteger(height)) return { ok: false, why: 'a census is read at a block height' };
    const derived = this.censusFor(roundIdBytes, height, { asRoundsOwn: false });
    return derived.ok ? { ...derived, atHeight: height } : derived;
  }

  // `posted`: the contract of a round being posted, not yet stored (RULED 2026-09-25: POST /round asks whether the round's
  // federation is bonded BEFORE round.open, so nothing of a refused round exists). The census derived is the same.
  censusFor(roundIdBytes, atHeight = null, { asRoundsOwn = true, posted = null } = {}) {
    let asStored = posted;
    if (!asStored) {
      const row = this.round.get(roundIdBytes);
      if (!row) return { ok: false, why: 'this node holds no such round' };
      asStored = decodeRoundContract(new Uint8Array(row.contract));
    }
    // The only thing a named height changes is which height the census is read at.
    const contract = atHeight === null ? asStored : { ...asStored, censusHeight: atHeight };

    const network = contract.networkId ? networkOf(contract.networkId) : null;
    if (network === null)
      return { ok: false, why: 'that round names a network this build has no genesis for' };

    const view = this.chainFor({ contract, roundIdBytes });
    if (view && view.pending)
      return { ok: false, why: 'this node is still reading its chain view for that round' };
    if (!view || !Array.isArray(view.blocks))
      return {
        ok: false,
        why: NO_CHAIN_VIEW_WHY,
      };

    // THE ONE ALREADY DERIVED, if it was derived from a view that begins where this one does, for this round's own
    // census height. Nothing that arrives later is in it.
    // A SERIES ROUND'S CENSUS IS ITS SERIES' (the owner 2026-09-30, measured on testnet4): every round of series 3cfbe516 names
    // one template - one census height, one network, one bond floor - and ~500 of them derived their census each, from a
    // ~2080-block view, past a 64-entry cache, on every listing: GET /rounds took over 90 s. Keyed by the series id, one
    // derivation serves the series. A round naming no series keeps its own key.
    const whose = contract.seriesId instanceof Uint8Array ? `series:${toHex(contract.seriesId)}` : toHex(roundIdBytes);
    const kept = `${whose}:${view.firstHeight}:${contract.censusHeight}:${asRoundsOwn ? 'round' : 'height'}`;
    const had = this.censuses.get(kept);
    if (had) return had;

    const byTxid = new Map();
    for (const block of view.blocks) {
      for (const raw of block.transactions || []) {
        try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ }
      }
    }

    // PICK B (old-series.js): series 3cfbe516's census is read as its publisher read it, from 154152
    const readFrom = isOldTestnet4Id(contract.networkId) && contract.seriesId instanceof Uint8Array && isOldTestnet4Series(contract.seriesId)
      && view.firstHeight < OLD_TESTNET4_SERIES_CENSUS_FROM
      ? { firstHeight: OLD_TESTNET4_SERIES_CENSUS_FROM, blocks: view.blocks.slice(OLD_TESTNET4_SERIES_CENSUS_FROM - view.firstHeight) } : view;
    const census = deriveCensus(readFrom, {
      contract,
      bond: bondSetFor(network),
      resolve: (e) => {
        const raw = byTxid.get(toHex(e.txid));
        return raw ? { transaction: raw } : null;
      },
      // THE NEWEST ADVERTISEMENT UPDATE (§5A.2), each checked against its bond's own node key
      verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    });
    if (!census.ok) return census;

    // AND IT HAS TO BE THIS ROUND'S CENSUS - when it is being asked for as this round's.
    //
    // Every contract names a `censusRoot`, and on this path nothing compared
    // it with what the chain actually gives. A round could name any
    // thirty-two bytes, and this node would derive a different census, signer node a
    // committee out of it, and serve that - which is the divergence 5A.2
    // exists to remove, arriving from the round's own header. The spec is
    // blunt: a round whose census root is not the one its census derives to
    // "IS INVALID and no honest node will issue receipts against it".
    //
    // The comparison is against the root DERIVED HERE, from blocks, at the
    // contract's own height - not against a list anybody presented, which is
    // what `censusRootMatchesRound` is for when somebody else brings entries.
    if (!asRoundsOwn) return census;
    if (!(contract.censusRoot instanceof Uint8Array) || contract.censusRoot.length !== 32)
      return { ok: false, why: 'that round names no census root to check against the chain' };
    if (!census.root.every((b, i) => b === contract.censusRoot[i]))
      return {
        ok: false,
        why: `that round names census root ${toHex(contract.censusRoot).slice(0, 16)} and the `
          + `chain gives ${toHex(census.root).slice(0, 16)} at height ${contract.censusHeight}`,
        root: census.root,
      };

    // KEPT ONLY WHEN IT IS THIS ROUND'S OWN: a refusal above is never kept, so a view that grows into the answer is
    // still derived when it can be.
    this.censuses.set(kept, census);
    if (this.censuses.size > Roster.CENSUS_KEPT) this.censuses.delete(this.censuses.keys().next().value);
    return census;
  }

  /**
   * THE BONDS OF THIS ROUND'S GUARDIANS, AS EVIDENCE A PAGE CHECKS ITSELF (M3; the owner 07:33: every
   * guardian has its own bond). Every census node whose advertisement names a guardian key of the
   * round's federation under guardian_of[], with its bond transaction and the merkle branch that
   * puts it in a block of this signer node's chain view. A hint, not a count: the page proves each into
   * headers it agreed from providers and counts with the keys its own lock client read off the
   * federation (blwp-client/src/guardians.js). A signer node can omit a bond here; it cannot forge one.
   */
  guardianBondsFor(roundIdBytes) {
    const census = this.censusFor(roundIdBytes);
    if (!census.ok) return census;
    const contract = decodeRoundContract(new Uint8Array(this.round.get(roundIdBytes).contract));
    const fid = toHex(contract.federationId);
    const view = this.chainFor({ contract, roundIdBytes });

    // ONE INDEX PER VIEW (the rounds of a series share their view): built once, not on every ask.
    let where = view && typeof view === 'object' ? whereOf.get(view) : null;
    if (!where) {
      where = new Map();
      for (const block of (view && Array.isArray(view.blocks) ? view.blocks : [])) {
        let txids;
        try { txids = (block.transactions || []).map((raw) => parseTransaction(raw).txid); } catch { continue; }
        txids.forEach((t, position) => where.set(toHex(t), { block, txids, position }));
      }
      if (view && typeof view === 'object') whereOf.set(view, where);
    }
    const bonds = [];
    for (const e of census.entries) {
      if (!((e.advert && e.advert.guardianOf) || []).some((g) => toHex(g.federationId) === fid)) continue;
      const at = where.get(toHex(e.txid));
      if (!at) continue;
      // AND ITS NEWEST ADVERTISEMENT UPDATE, where the census applied one (§5A.2): the page proves it into its own headers
      // and reads the guardian keys from it, not from the bond's first advertisement
      const up = e.updatedBy ? where.get(toHex(e.updatedBy.txid)) : null;
      bonds.push({
        nodePubkey: toHex(e.pubkey), position: at.position,
        transaction: toHex(at.block.transactions[at.position]),
        branch: merkleBranchOf(at.txids, at.position).map(toHex),
        ...(up ? { update: { transaction: toHex(up.block.transactions[up.position]), position: up.position,
          branch: merkleBranchOf(up.txids, up.position).map(toHex) } } : {}),
      });
    }
    return { ok: true, federationId: fid, bonds };
  }

  /**
   * EVERY SIGNER NODE THIS ROUND HAS, over the roles its contract names slots for.
   *
   * A contract carries one flat `nodes` list, so the assigned set is the union
   * of the role committees - a node assigned for either pool is assigned.
   */
  signerNodesFor(roundIdBytes) {
    const signerNodes = new Map();
    for (const role of ['game', 'settlement']) {
      const picked = this.committeeFor(roundIdBytes, role);
      if (!picked.ok) return picked;
      for (const e of picked.committee) signerNodes.set(toHex(e.pubkey), e.pubkey);
    }
    return { ok: true, signerNodes: [...signerNodes.values()] };
  }

  /**
   * ASSIGN THE ROUND'S SIGNER NODES, and refuse one whose contract names anybody else.
   *
   * 26's ruling: the assigned set from the chain census is the only list that
   * counts. `contract.nodes` is what a round's author wrote down, so it is
   * CHECKED against the signer nodes - exactly, both ways - and a contract naming a
   * stranger, omitting a assigned node, or being a different set altogether is
   * refused by name rather than rewritten or accepted on overlap.
   *
   * The signer nodes are stored, so `takeReceipt` and the verdict read the census's
   * answer rather than each deciding for themselves.
   */
  assignSignerNodes(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'this node holds no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    const assigned = this.signerNodesFor(roundIdBytes);
    if (!assigned.ok) return assigned;

    const named = Array.isArray(contract.nodes) ? contract.nodes : [];
    const have = new Set(assigned.signerNodes.map(toHex));
    const says = new Set(named.map(toHex));

    const strangers = [...says].filter((k) => !have.has(k));
    const missing = [...have].filter((k) => !says.has(k));
    if (strangers.length || missing.length)
      return {
        ok: false,
        why: `that round names ${named.length} committee ${named.length === 1 ? 'key' : 'keys'} and `
          + `the census assigns ${assigned.signerNodes.length}: `
          + `${strangers.length} the chain did not assign`
          + `${strangers.length ? ` (${strangers[0].slice(0, 16)})` : ''}, `
          + `${missing.length} assigned ${missing.length === 1 ? 'node' : 'nodes'} it does not name`
          + `${missing.length ? ` (${missing[0].slice(0, 16)})` : ''}`,
      };

    this.round.recordSignerNodes(roundIdBytes, assigned.signerNodes);
    return { ok: true, signerNodes: assigned.signerNodes };
  }

  /**
   * The committee for a role, or the reason this round cannot be held.
   *
   * `selectCommittee` is what refuses a census smaller than the network's
   * minimum - a caller that pre-checked it here would be the second place that
   * rule lived, and the two would drift.
   */
  /**
   * ASSIGNED ONCE PER ROUND, FROM THE CENSUS ROOT AND THE SEED (the owner 2026-09-18 01:30, the ghost lag).
   *
   * Keyed on the view's length it was rebuilt on every block - about ten a minute on the Daily - and that rebuild was
   * the 132-165 ms left sitting in the pictured truck's stalls. A committee cannot change when a header arrives: the
   * census is fixed at the round's census height and the seed is the randomness published after the round id, fixed
   * once the view reaches the beacon. So the key is what the answer is made of. A different census root or a different
   * seed misses and is assigned again; a refusal is never kept; and the chain check behind the seed still runs when the
   * view grows, so nothing is verified less often than before.
   */
  committeeFor(roundIdBytes, role) {
    const row = this.round.get(roundIdBytes);
    const contract = row ? decodeRoundContract(new Uint8Array(row.contract)) : null;
    const census = contract ? this.censusFor(roundIdBytes) : null;
    const seeded = contract ? this.seedFor(roundIdBytes, contract) : null;
    const kept = census && census.ok && seeded && seeded.ok && seeded.seed
      ? `${toHex(roundIdBytes)}:${role}:${toHex(census.root)}:${toHex(seeded.seed)}` : null;
    if (kept && this.committees.has(kept)) return this.committees.get(kept);
    const answer = timed(`committee assigned ${toHex(roundIdBytes).slice(0, 8)}`,
      () => this.#committeeFor(roundIdBytes, role), { over: 20 });
    if (kept && answer.ok) {
      this.committees.set(kept, answer);
      if (this.committees.size > Roster.PER_ROUND_KEPT) this.committees.delete(this.committees.keys().next().value);
    }
    return answer;
  }

  #committeeFor(roundIdBytes, role) {
    const census = this.censusFor(roundIdBytes);
    if (!census.ok) return census;

    const row = this.round.get(roundIdBytes);
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    // THE LOTTERY IS DRAWN ON THE BEACON'S SEED. Not on `contract.committeeSeed`:
    // that field is the author's claim about it, and 34 offline tries were
    // enough to make it signer node a chosen pair.
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
