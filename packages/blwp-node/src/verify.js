// WHAT THE DAEMON DOES WHEN A ROUND CLOSES.
//
// Everything under it was already built and nothing called it: the pool, the
// replay and the signing were reachable only from tests, which is another way
// of saying the daemon did not do them. Section 13 has each committee node
// replay the canonical transcript once the round is over and sign what it
// found - so closing a round is the event, and this is the thing that hears it.
//
// IT IS NOT A SECOND SIMULATOR AND IT HAS NO CLOCK. It reacts to a close and
// stops when the queue empties. Nothing here polls, nothing ticks, and nothing
// here reaches the core: `replay.js` remains the only file in this daemon that
// does, and this file only decides which runs are handed to it.
import { ReplayPool } from './pool.js';
import { resultFrom, signResult, verifiedFinal } from './verdict.js';
import {
  joinSignedResult, splitSignedResult, decodePlayerResult, resultId, SIGNED_RESULT_BYTES,
} from '../../protocol/src/result.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { committeeSeedFromBeacon, beaconFromChain, beaconIsTheChains } from '../../protocol/src/beacon.js';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * WHAT A BEACON IS WORTH TO THIS NODE, worked out once per round.
 *
 * The published value feeds TWO seeds and they are not the same number:
 *
 *   world seed      H(round_randomness || pubkey || worldSecret || joinTick),
 *                   per player, and what `replay` rebuilds the run from
 *   committee seed  H(census roots || round_id || round_randomness), 5A.5,
 *                   and what decides which nodes hold the round
 *
 * One SOURCE feeds both, because they must be the same round's randomness, and
 * they stay two numbers because they answer different questions. Collapsing
 * them would make a player's private world a function of the committee's seed.
 *
 * AND NEITHER IS PRODUCED FROM A VALUE THAT PROVES NOTHING. A hash with no
 * height, or one from a height the round already committed to, is refused
 * here - before a run is replayed rather than after - because a round whose
 * committee could have been ground is not a round to sign a result for.
 */
function beaconFor(randomnessFor, contract, roundIdBytes, entry, entryId, chainFor) {
  const given = randomnessFor({ contract, roundIdBytes, entry, entryId });
  const hash = given && (given.hash || (given instanceof Uint8Array ? given : undefined));
  const height = given && given.height;
  const seeded = committeeSeedFromBeacon(contract, {
    roundId: roundIdBytes, randomness: hash, height, timeMs: given && given.timeMs,
  });
  if (!seeded.ok) return seeded;

  // AND AGAINST THIS NODE'S OWN CHAIN, exactly as the roster asks at seating.
  //
  // 27's rule is all `committeeSeedFromBeacon` can ask - it has no chain - and
  // "after committee_time" is not "the block the chain names". The beacon here
  // is not idle: `replay` derives every player's world from it, so a node
  // closing on a late-but-wrong block computes a different world, a different
  // state hash and a result no honest node will agree with. The same door the
  // seat goes through, for the same reason.
  //
  // A node with no view is left as it was: it has no chain to ask, 27's rule
  // has already run, and refusing here would refuse every node that closes
  // without one.
  const view = chainFor ? chainFor({ contract, roundIdBytes }) : null;
  if (view && Array.isArray(view.blocks) && view.blocks.length) {
    const headers = { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight };
    const named = beaconFromChain(contract, headers);
    if (!named.ok) return named;
    const agrees = beaconIsTheChains(contract, { hash, height, timeMs: given && given.timeMs },
      headers);
    if (!agrees.ok) return agrees;
  }

  return { ok: true, hash, height, committeeSeed: seeded.seed, rootsAreOne: seeded.rootsAreOne };
}

/**
 * WHERE THE ROUND'S RANDOMNESS COMES FROM, AND IT IS NOT INVENTED HERE.
 *
 * The seed stopped being a hole: the owner put the world secret on the Entry
 * Contract (e942580) and `replay` now derives H(round_randomness || pubkey ||
 * secret || join_tick) for itself. What it still needs is the first of those
 * four, and section 5A makes it a FUTURE BITCOIN BLOCK HASH - randomness
 * nobody in the round can grind, drawn at a height after committee_time.
 *
 * That is chain state this daemon does not read yet, and a node that made one
 * up would be seeding a world its peers could not reproduce. So the source is
 * asked for and refused when absent, in `replay`'s own words. Nothing here
 * defaults it to zeros, and nothing here draws it.
 */
export const NO_RANDOMNESS_SOURCE = () => undefined;

export class Verifier {
  constructor(round, {
    randomnessFor = NO_RANDOMNESS_SOURCE, chainFor = null, pool = new ReplayPool(), peers = [],
  } = {}) {
    this.round = round;
    this.randomnessFor = randomnessFor;
    /** The chain this node has, so the beacon it closes on can be checked. */
    this.chainFor = chainFor;
    /**
     * THE OTHER SEATS, as base URLs. A node's committee is named in the round
     * contract by KEY, and a key is not an address: 25.1 makes finding an
     * address discovery's job, which is not this letter's. So the operator
     * says where its peers are and the CONTRACT still says whose signatures
     * count - a peer that is not on the committee can answer all it likes and
     * still not be a seat.
     */
    this.peers = peers;
    /** The committee seed each closed round derived, by round id. */
    this.seeds = new Map();
    this.pool = pool;
    /** What the last close produced, so a caller can wait for it or read it. */
    this.done = [];
    /** What it QUEUED, and how - so a node can be asked what it thought it had. */
    this.queued = [];
    /** The last close's whole sequence: replays, then the asking. */
    this.settling = Promise.resolve([]);
  }

  /**
   * QUEUE EVERY STORED ENTRY OF A ROUND THAT HAS JUST CLOSED.
   *
   * The objected ones go in objected, which is all the pool needs to put them
   * first; it is the node's own table that says so, not the caller.
   *
   * Returns a promise per entry so a daemon can ignore them and a test can
   * wait. Nothing is thrown at the socket that closed the round: a replay that
   * cannot run is a fact to record, not an error to hand back to whoever said
   * "close".
   */
  onRoundClosed(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return [];
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    this.queued = [];
    const work = this.round.entriesOf(roundIdBytes).map(({ entryId, entry }) => {
      // THE BEACON BEFORE THE REPLAY. A round whose committee could have been
      // ground is not a round to spend a worker on, and it is certainly not
      // one to sign a result for.
      const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, entry, entryId,
        this.chainFor);
      if (!beacon.ok) {
        this.queued.push({ entryId, objected: false, refused: beacon.why });
        return Promise.resolve({ entryId, stored: false, why: beacon.why });
      }
      this.seeds.set(hex(roundIdBytes), beacon.committeeSeed);

      const transcript = this.round.transcript(roundIdBytes, entryId);
      const objected = this.round.objected(roundIdBytes, entryId);
      this.queued.push({ entryId, objected });
      return this.pool.submit({
        key: `${hex(roundIdBytes)}:${hex(entryId)}`,
        objected,
        transcript,
        entry,
        // The WORLD seed's half of the same published value.
        options: { roundRandomness: beacon.hash },
      }).then((answer) => this.#keep({ roundIdBytes, entryId, entry, contract, answer }));
    });

    this.done = work;
    return work;
  }

  /**
   * SIGN WHAT THE REPLAY FOUND, AND KEEP IT.
   *
   * The canonical transcript is the one section 13 says is replayed and 13C
   * defines - the prefix of marks the committee receipted - so it is what the
   * result's `transcript_hash` is taken over. A run with no canonical
   * transcript yet is not signed, and the reason is carried back rather than
   * swallowed: a node that signed over the rows it happened to hold would be
   * signing a different object from the one its peers signed.
   */
  #keep({ roundIdBytes, entryId, entry, contract, answer }) {
    if (!answer.ok) return { entryId, stored: false, why: answer.why };

    let canonical;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryId); }
    catch (err) { return { entryId, stored: false, why: err.message }; }

    const built = resultFrom({
      answer, contract, entry, transcript: canonical, entryId,
      nodePubkey: this.round.pubkey,
    });
    if (!built.ok) return { entryId, stored: false, why: built.why };

    const signed = signResult(built.result, this.round.identity.secret);
    const bytes = joinSignedResult(built.encoded, signed.signature);
    this.round.putResult(roundIdBytes, entryId, this.round.pubkey, signed.resultId, bytes);
    // THE SCORE AND THE PLAYER TRAVEL WITH THE OUTCOME. Both are already in
    // the object this node signed, and 23.2's table needs all three: the word
    // says which act, the score says whether the player placed, and the pool
    // is ordered by key. A caller that had to go and decode the signed result
    // again to learn them would be reading back what it just wrote.
    return { entryId, stored: true, resultId: signed.resultId,
      outcome: built.result.outcome, score: built.result.score,
      playerPubkey: entry.playerPubkey, stakeMsat: entry.stakeMsat,
      // the fee and the donation too: 23.2's table is over NET stakes (22A)
      feeMsat: entry.feeMsat, donationMsat: entry.donationMsat };
  }

  /**
   * WHAT A CLOSE ACTUALLY SETS OFF: replay every entry, then ask the other
   * seats about the ones that produced a signature.
   *
   * Kept as one method, and the promise kept on `settling`, because the two
   * halves are one event - a node that replayed and never asked has done half
   * of section 13 - and because a caller that cannot await the whole thing
   * cannot tell "not fetched yet" from "not fetched".
   */
  settleRound(roundIdBytes) {
    // WHAT IT RESOLVES WITH IS BOTH HALVES. The replays carry the core's own
    // outcome word for every entry and the gathers carry whether the committee
    // agreed on it - and a caller deciding what happens to a stake needs one
    // of each. Nothing here moves money: this is section 13, and the money
    // word is `Custody.settleHeldInvoices`.
    this.settling = Promise.all(this.onRoundClosed(roundIdBytes))
      .then(async (replayed) => ({
        replayed,
        gathered: await Promise.all(replayed
          .filter((d) => d && d.stored)
          .map((d) => this.gather(roundIdBytes, d.entryId))),
      }));
    return this.settling;
  }

  /**
   * ASK THE OTHER SEATS WHAT THEY FOUND, AND COUNT.
   *
   * Serving a result nobody fetches is a committee of one writing in a diary.
   * Section 13 needs five of seven to have signed the IDENTICAL result, and
   * that is only checkable by a node holding more than its own signature.
   *
   * WHAT COMES BACK IS NOT TRUSTED. Every record is split, decoded, re-encoded
   * to its own id and checked against the signature under the key it names -
   * a peer that sends somebody else's bytes, or its own bytes with a borrowed
   * key, is dropped before anything is written. Then `verifiedFinal` does the
   * counting against the contract's own slots, so a peer cannot make itself a
   * seat by answering.
   */
  async gather(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    // WHOSE RUN THIS IS, off the entry the node itself stores.
    const mine = this.round.entriesOf(roundIdBytes)
      .find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!mine) return { ok: false, why: 'no such entry in that round' };
    const playerPubkey = mine.entry.playerPubkey;

    let fetched = 0, kept = 0, refused = 0;
    for (const peer of this.peers) {
      let body;
      try {
        const url = `${peer}/results?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`;
        const answer = await fetch(url);
        if (!answer.ok) { refused++; continue; }
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { refused++; continue; }      // a peer that is down is not a fault

      for (let at = 0; at + SIGNED_RESULT_BYTES <= body.length; at += SIGNED_RESULT_BYTES) {
        fetched++;
        const record = body.subarray(at, at + SIGNED_RESULT_BYTES);
        if (this.#keepPeerResult(roundIdBytes, entryIdBytes, record, playerPubkey)) kept++;
      }
    }

    const held = this.round.results(roundIdBytes, entryIdBytes);
    const seen = verifiedFinal(held.map((r) => r.bytes), {
      contract, seats: this.round.seats(roundIdBytes),
    });
    // The entry is in the answer because a caller with a round's worth of
    // them cannot otherwise say which run each one is about.
    return { ok: true, entryId: entryIdBytes, fetched, kept, refused, held: held.length, ...seen };
  }

  /** One record from a peer, believed only as far as it can be checked. */
  #keepPeerResult(roundIdBytes, entryIdBytes, record, playerPubkey) {
    let result, signature;
    try {
      const split = splitSignedResult(record);
      signature = split.signature;
      result = decodePlayerResult(split.body);
    } catch { return false; }

    // IT MUST BE ABOUT THIS RUN, and a PlayerResult names its round and its
    // PLAYER - never an entry - so both are checked and the entry is what the
    // player is looked up from.
    //
    // The player half is not tidiness. The store keys a result by (round,
    // entry, signer), so a record about another player filed under this entry
    // would take that seat's row - and the seat's true record, arriving later,
    // would be ignored as a duplicate. One peer could then stop any seat's
    // real answer from ever being stored, without forging a signature.
    if (hex(result.roundId) !== hex(roundIdBytes)) return false;
    if (!(playerPubkey instanceof Uint8Array)
      || hex(result.playerPubkey) !== hex(playerPubkey)) return false;

    const id = resultId(result);
    let ok = false;
    try { ok = schnorr.verify(signature, id, result.nodePubkey); } catch { ok = false; }
    if (!ok) return false;

    return this.round.putResult(
      roundIdBytes, entryIdBytes, result.nodePubkey, id, record) === 1;
  }

  /**
   * A RUN THAT COULD NOT BE SIGNED YET, TRIED AGAIN.
   *
   * A replay finished before the committee had carried the transcript is not a
   * failure, it is an EARLY one: 13C's prefix grows as receipts arrive, so the
   * same run signs later without anything else changing. Without this a late
   * receipt would leave the run permanently unsigned - the node would have
   * replayed it, found the answer, and thrown the answer away.
   *
   * A run this node has already signed is not replayed again: one seat, one
   * result, and re-signing is what the store refuses anyway.
   */
  retry(roundIdBytes, entryIdBytes) {
    if (this.round.hasResult(roundIdBytes, entryIdBytes, this.round.pubkey)) return null;
    const row = this.round.get(roundIdBytes);
    if (!row) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = this.round.entriesOf(roundIdBytes)
      .find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return null;

    const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry,
      entryIdBytes, this.chainFor);
    if (!beacon.ok) return null;
    this.seeds.set(hex(roundIdBytes), beacon.committeeSeed);

    const work = this.pool.submit({
      key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:retry`,
      objected: this.round.objected(roundIdBytes, entryIdBytes),
      transcript: this.round.transcript(roundIdBytes, entryIdBytes),
      entry: found.entry,
      options: { roundRandomness: beacon.hash },
    }).then((answer) => this.#keep({
      roundIdBytes, entryId: entryIdBytes, entry: found.entry, contract, answer,
    }));
    this.done = [...this.done, work];
    return work;
  }
}

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
