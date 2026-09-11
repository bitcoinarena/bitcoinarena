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
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { resultFrom, signResult, verifiedFinal, runId } from './verdict.js';
import {
  encodeTranscriptPosting, transcriptPostingId, joinSignedPosting, splitSignedPosting, decodeTranscriptPosting,
  transcriptBytesHash, relayPath, transcriptIsPublished, SIGNED_POSTING_BYTES,
} from '../../protocol/src/posting.js';
import {
  encodeRerunResult, rerunResultId, joinSignedRerun, splitSignedRerun, decodeRerunResult, rerunIsAgreed,
  SIGNED_RERUN_BYTES,
} from '../../protocol/src/rerun.js';
import { encodeSlashProof, slashProofId, slashHolds, joinSlashEvidence } from '../../protocol/src/slash.js';
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
    peersFor = null, advertsFor = null,
  } = {}) {
    /**
     * THE SEATS' OWN ADVERTISEMENTS, by round: a Map of node key (hex) to the
     * decoded advertisement, whose bond outpoint a slash proof must name. The
     * daemon passes its census's (5A.2 resolves the bodies out of the blocks).
     */
    this.advertsFor = advertsFor;
    /**
     * THE OTHER SEATS OF ONE ROUND, when the operator named none: a function
     * of the round, because a committee is a round's. The daemon passes the
     * census's own addresses - the signed advertisement in each seat's bond -
     * which is the record seat selection already reads. Measured on the regtest
     * rehearsal before it: both daemons' `peers` were [], so a close could ask
     * nobody for anything.
     */
    this.peersFor = peersFor;
    /** What each close carried from its peers, by `round:entry`. */
    this.carried = new Map();
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
      // THE PEERS' RECEIPTS BEFORE THE CANONICAL CHAIN IS TAKEN (13C). Each
      // seat receipts a mark itself and keeps only its own half, so a node
      // that asked nobody could never hold T of them. Pulled here, by the
      // node, and not trusted to the client: a losing player who withheld
      // receipts would reach no-quorum and a VOID refund.
      return this.carryReceipts(roundIdBytes, entryId).then(() => this.pool.submit({
        key: `${hex(roundIdBytes)}:${hex(entryId)}`,
        objected,
        transcript,
        entry,
        // The WORLD seed's half of the same published value.
        options: { roundRandomness: beacon.hash },
      })).then((answer) => this.#keep({ roundIdBytes, entryId, entry, contract, answer }));
    });

    this.done = work;
    return work;
  }

  /**
   * WHO TO ASK ABOUT ONE ROUND. A list the operator gave wins; otherwise the
   * round's own committee, from the census (`peersFor`); otherwise nobody.
   */
  peersOf(roundIdBytes) {
    if (this.peers && this.peers.length) return this.peers;
    if (typeof this.peersFor !== 'function') return [];
    try { return this.peersFor(roundIdBytes) || []; } catch { return []; }
  }

  /**
   * TAKE EVERY PEER'S RECEIPTS FOR ONE RUN, EACH THROUGH `takeReceipt`.
   *
   * Nothing is believed on arrival: `takeReceipt` stores a record only if the
   * mark is one this node holds, the signer is seated on this round, and the
   * signature verifies - the same three checks as ever. A peer that is down is
   * named and skipped, never fatal: the next peer may carry what this one
   * could not. Kept in `carried` so a close can say what it was offered.
   */
  async carryReceipts(roundIdBytes, entryIdBytes) {
    const report = { taken: 0, refused: [], down: [] };
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/receipts?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) { report.down.push(`${peer}: answered ${answer.status}`); continue; }
        body = new Uint8Array(await answer.arrayBuffer());
      } catch (e) { report.down.push(`${peer}: ${e.message}`); continue; }
      for (let at = 0; at + SIGNED_RECEIPT_BYTES <= body.length; at += SIGNED_RECEIPT_BYTES) {
        try {
          this.round.takeReceipt(body.slice(at, at + SIGNED_RECEIPT_BYTES));
          report.taken++;
        } catch (e) { report.refused.push(`${peer}: ${e.message}`); }
      }
    }
    this.carried.set(`${hex(roundIdBytes)}:${hex(entryIdBytes)}`, report);
    return report;
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
    for (const peer of this.peersOf(roundIdBytes)) {
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

  /**
   * POST THE AGREED RUN'S TRANSCRIPT WHERE ANYONE CAN REPLAY IT, AND SAY SO (P2).
   *
   * v4.6.2 §13A: a result is not FINAL until the canonical transcript it names
   * has been retrieved by the round's threshold of settlement seats and posted
   * by them to the contract's `publication_relays[]`. Measured before this: a
   * seven-seat run and a two-daemon round went FINAL and moved money with the
   * contract's relay asked nothing (publication-finality.test.js).
   *
   * This seat, if it is one: take the transcript the agreed result names - its
   * own canonical one, else a peer's `/canonical`, either way only if its bytes
   * hash to that name - PUT it to every relay, read it back, and only when at
   * least one relay gives back the same bytes sign a posting. Then take every
   * peer's postings, each checked as far as it can be. Idempotent: a seat that
   * has posted does not post again, and the gather is the same gather.
   */
  async publish(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const seats = this.round.seats(roundIdBytes);
    const mine = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!mine) return { ok: false, why: 'no such entry in that round' };
    const playerPubkey = mine.entry.playerPubkey;

    // WHICH TRANSCRIPT: the one the agreed run names, and no other.
    const held = this.round.results(roundIdBytes, entryIdBytes);
    const seen = verifiedFinal(held.map((r) => r.bytes), { contract, seats });
    if (!seen.ok || !seen.final) return { ok: false, why: seen.why || 'no run of that entry is agreed yet' };
    let transcriptHash = null;
    for (const r of held) {
      try {
        const res = decodePlayerResult(splitSignedResult(r.bytes).body);
        if (hex(runId(res)) === seen.runId) { transcriptHash = res.transcriptHash; break; }
      } catch { /* a record that does not decode names nothing */ }
    }
    if (!transcriptHash) return { ok: false, why: 'the agreed run names no transcript this node can read' };

    const report = { relays: [], refused: [] };
    const seated = seats.some((s) => hex(s) === hex(this.round.pubkey));
    const said = this.round.postings(roundIdBytes, entryIdBytes).some((p) => hex(p.seatPubkey) === hex(this.round.pubkey));
    const relays = contract.publicationRelays || [];
    if (seated && !said && !relays.length)
      report.refused.push('the round contract names no publication relay, so this seat can post its transcript nowhere');
    if (seated && !said && relays.length) {
      const bytes = await this.#transcriptNamed(roundIdBytes, entryIdBytes, transcriptHash, report);
      let readBack = 0;
      for (const relay of bytes ? relays : []) {
        const at = `${String(relay).replace(/\/+$/, '')}${relayPath(transcriptHash)}`;
        try {
          const put = await fetch(at, { method: 'PUT', body: bytes });
          if (!put.ok) { report.refused.push(`${relay}: kept nothing (${put.status})`); continue; }
          const back = new Uint8Array(await (await fetch(at)).arrayBuffer());
          if (hex(back) !== hex(bytes)) { report.refused.push(`${relay}: gave back other bytes`); continue; }
          readBack++;
          report.relays.push(relay);
        } catch (e) { report.refused.push(`${relay}: ${e.message}`); }
      }
      if (readBack) {
        const posting = { roundId: roundIdBytes, playerPubkey, transcriptHash, seatPubkey: this.round.pubkey };
        const body = encodeTranscriptPosting(posting);
        const signature = schnorr.sign(transcriptPostingId(posting), this.round.identity.secret);
        this.round.putPosting(roundIdBytes, entryIdBytes, this.round.pubkey, joinSignedPosting(body, signature));
      }
    }

    // AND THE OTHER SEATS' WORD, each checked here, never taken on arrival.
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/postings?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) continue;
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { continue; }                  // a peer that is down is not a fault
      for (let at = 0; at + SIGNED_POSTING_BYTES <= body.length; at += SIGNED_POSTING_BYTES)
        this.#keepPeerPosting(roundIdBytes, entryIdBytes, body.slice(at, at + SIGNED_POSTING_BYTES), playerPubkey, seats);
    }

    const count = transcriptIsPublished({
      roundId: roundIdBytes, playerPubkey, transcriptHash, postings: this.round.postings(roundIdBytes, entryIdBytes),
      seats, settlementSlots: contract.settlementSlots, verify: (s, m, k) => schnorr.verify(s, m, k),
    });
    return { ...count, entryId: entryIdBytes, ...report };
  }

  /**
   * RE-RUN A SUSPENDED RESULT, AND COUNT THE COMMITTEE'S RE-RUNS (v4.6.2 §13A).
   *
   * "The full committee re-runs the canonical transcript; the replay outcome is
   * authoritative." Measured before this: a result five of seven signed and a
   * valid objection contradicted stayed SUSPENDED two windows later, nothing
   * released and nothing re-run (rerun.test.js, 2f01ea1).
   *
   * This seat, if it is one and has not re-run this run yet: replays the run
   * again through the same pool as the close - a new job, not its old answer -
   * and signs the result the CURRENT canonical transcript gives, tied to the
   * contradicted run. Then takes every peer's re-runs, each checked. Returns the
   * count; whether it replaces SUSPENDED is `resultFinality`'s to say.
   */
  async rerun(roundIdBytes, entryIdBytes, contradictedRunId) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const seats = this.round.seats(roundIdBytes);
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return { ok: false, why: 'no such entry in that round' };
    const report = { refused: [] };

    const seated = seats.some((s) => hex(s) === hex(this.round.pubkey));
    const done = this.round.reruns(roundIdBytes, entryIdBytes).some((r) => hex(r.seatPubkey) === hex(this.round.pubkey));
    if (seated && !done) {
      const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry, entryIdBytes, this.chainFor);
      if (!beacon.ok) report.refused.push(beacon.why);
      else {
        const answer = await this.pool.submit({
          key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:rerun`,
          objected: true,
          transcript: this.round.transcript(roundIdBytes, entryIdBytes),
          entry: found.entry,
          options: { roundRandomness: beacon.hash },
        });
        let canonical = null;
        if (!answer.ok) report.refused.push(answer.why);
        else {
          try { canonical = this.round.canonicalTranscript(roundIdBytes, entryIdBytes); }
          catch (e) { report.refused.push(e.message); }
        }
        const built = canonical && resultFrom({
          answer, contract, entry: found.entry, transcript: canonical, entryId: entryIdBytes,
          nodePubkey: this.round.pubkey,
        });
        if (built && !built.ok) report.refused.push(built.why);
        if (built && built.ok) {
          const x = { contradictedRunId, result: built.result };
          const signature = schnorr.sign(rerunResultId(x), this.round.identity.secret);
          this.round.putRerun(roundIdBytes, entryIdBytes, this.round.pubkey, joinSignedRerun(encodeRerunResult(x), signature));
        }
      }
    }

    // AND THE OTHER SEATS' RE-RUNS, each checked here, never taken on arrival.
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/reruns?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) continue;
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { continue; }
      for (let at = 0; at + SIGNED_RERUN_BYTES <= body.length; at += SIGNED_RERUN_BYTES)
        this.#keepPeerRerun(roundIdBytes, body.slice(at, at + SIGNED_RERUN_BYTES), found.entry.playerPubkey, seats, entryIdBytes);
    }

    const count = rerunIsAgreed({
      roundId: roundIdBytes, playerPubkey: found.entry.playerPubkey, contradictedRunId,
      records: this.round.reruns(roundIdBytes, entryIdBytes), seats, slots: contract.gameVerifySlots,
      verify: (s, m, k) => schnorr.verify(s, m, k),
    });
    return { ...count, ...report };
  }

  /**
   * FILE A SLASH PROOF AGAINST EVERY SEAT THE RE-RUN CONTRADICTED (§13A, 5A.3B).
   *
   * "Every node that signed the contradicted result is slashed (§5A.3)." 5A.3B
   * step 1, anyone publishes the fraud proof; step 2, it is mechanically
   * checkable. So for each result this node holds whose run is the contradicted
   * one: a REPLAY_CONTRADICTS proof naming the canonical transcript, the signed
   * result and the bond the seat's OWN advertisement names - filed only if
   * `slashHolds` says it slashes, kept beside its evidence, served, and posted
   * to the round's relays. The one judgement, that the replay differed, is this
   * node's own replay: it is the re-run's authoritative outcome and not the
   * contradicted one. Steps 3 and 5 are the arbitration set's.
   */
  async fileSlashProofs(roundIdBytes, entryIdBytes, contradictedRunId, authoritativeRunId) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { filed: [], refused: ['no such round'] };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const seats = this.round.seats(roundIdBytes);
    const report = { filed: [], refused: [] };
    let canonical;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryIdBytes); }
    catch (e) { report.refused.push(e.message); return report; }

    const held = this.round.results(roundIdBytes, entryIdBytes);
    const mine = held.find((r) => hex(r.nodePubkey) === hex(this.round.pubkey));
    if (!mine) { report.refused.push('this node signed no result for that run, so it has no replay to accuse with'); return report; }
    const myRun = hex(runId(decodePlayerResult(splitSignedResult(mine.bytes).body)));
    const replayDiffers = myRun !== hex(contradictedRunId) && myRun === hex(authoritativeRunId);

    let adverts = null;
    try { adverts = this.advertsFor ? this.advertsFor(roundIdBytes) : null; } catch { adverts = null; }
    const filed = new Set(this.round.slashProofs(roundIdBytes, entryIdBytes).map((p) => hex(p.nodePubkey)));
    for (const r of held) {
      let body;
      try { body = decodePlayerResult(splitSignedResult(r.bytes).body); } catch { continue; }
      if (hex(runId(body)) !== hex(contradictedRunId)) continue;
      const who = hex(body.nodePubkey);
      if (filed.has(who)) continue;
      const advert = adverts instanceof Map ? adverts.get(who) : null;
      if (!advert) { report.refused.push(`${who.slice(0, 16)}: no advertisement names its bond`); continue; }
      const proof = {
        roundId: roundIdBytes, playerPubkey: body.playerPubkey, nodePubkey: body.nodePubkey,
        transcriptHash: canonical.hash, signedResultId: resultId(body),
        bondTxid: advert.bondTxid, bondVout: advert.bondVout,
      };
      const check = slashHolds({
        proof, signedResult: r.bytes, advert, committee: seats,
        canonicalTranscriptHash: canonical.hash, replayDiffers,
      });
      if (!check.slashed) { report.refused.push(`${who.slice(0, 16)}: ${check.why}`); continue; }
      const id = slashProofId(proof);
      const record = joinSlashEvidence(encodeSlashProof(proof), r.bytes);
      this.round.putSlashProof(roundIdBytes, entryIdBytes, body.nodePubkey, id, record);
      report.filed.push(who);
      for (const relay of contract.publicationRelays || []) {
        try {
          const put = await fetch(`${String(relay).replace(/\/+$/, '')}/slash/${hex(id)}`, { method: 'PUT', body: record });
          if (!put.ok) report.refused.push(`${relay}: kept no proof (${put.status})`);
        } catch (e) { report.refused.push(`${relay}: ${e.message}`); }
      }
    }
    return report;
  }

  /** One re-run from a peer: about this round and player, from a seated seat, and signed by it. */
  #keepPeerRerun(roundIdBytes, record, playerPubkey, seats, entryIdBytes) {
    let x, signature;
    try {
      const split = splitSignedRerun(record);
      signature = split.signature;
      x = decodeRerunResult(split.body);
    } catch { return false; }
    if (hex(x.result.roundId) !== hex(roundIdBytes) || hex(x.result.playerPubkey) !== hex(playerPubkey)) return false;
    if (!seats.some((s) => hex(s) === hex(x.result.nodePubkey))) return false;
    let ok = false;
    try { ok = schnorr.verify(signature, rerunResultId(x), x.result.nodePubkey); } catch { ok = false; }
    if (!ok) return false;
    return this.round.putRerun(roundIdBytes, entryIdBytes, x.result.nodePubkey, record) === 1;
  }

  /** The transcript a hash names: this node's canonical one, else a peer's - only bytes with that hash. */
  async #transcriptNamed(roundIdBytes, entryIdBytes, transcriptHash, report) {
    try {
      const own = this.round.canonicalTranscript(roundIdBytes, entryIdBytes);
      if (hex(own.hash) === hex(transcriptHash)) return own.bytes;
    } catch { /* not held here; a peer may */ }
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const answer = await fetch(`${peer}/canonical?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) continue;
        const bytes = new Uint8Array(await answer.arrayBuffer());
        if (hex(transcriptBytesHash(bytes)) === hex(transcriptHash)) return bytes;
        report.refused.push(`${peer}: served a transcript that is not the one the agreed result names`);
      } catch { /* the next peer may have it */ }
    }
    report.refused.push('no seat served the transcript the agreed result names');
    return null;
  }

  /** One posting from a peer: about this round and player, from a seated seat, and signed by it. */
  #keepPeerPosting(roundIdBytes, entryIdBytes, record, playerPubkey, seats) {
    let p, signature;
    try {
      const split = splitSignedPosting(record);
      signature = split.signature;
      p = decodeTranscriptPosting(split.body);
    } catch { return false; }
    if (hex(p.roundId) !== hex(roundIdBytes) || hex(p.playerPubkey) !== hex(playerPubkey)) return false;
    if (!seats.some((s) => hex(s) === hex(p.seatPubkey))) return false;
    let ok = false;
    try { ok = schnorr.verify(signature, transcriptPostingId(p), p.seatPubkey); } catch { ok = false; }
    if (!ok) return false;
    return this.round.putPosting(roundIdBytes, entryIdBytes, p.seatPubkey, record) === 1;
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
