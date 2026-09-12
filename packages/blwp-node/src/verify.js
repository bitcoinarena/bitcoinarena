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
import { stoppedOutcome } from '../../protocol/src/first-mark.js';
import { noQuorumOutcome as noQuorumRule } from '../../protocol/src/payout.js';
import {
  provesEquivocation, SIGNED_CHECKPOINT_BYTES as SIGNED_MARK_BYTES, splitSigned as splitMark,
  decodeCheckpoint as decodeMark, checkpointId as markIdOf,
} from '../../protocol/src/checkpoint.js';
import { ed25519 as sessionCurve } from '@noble/curves/ed25519.js';
import { resultFinality as finalityOf } from './finality.js';

let retryJobs = 0;                     // each re-tried close is its own pool job
import { encodeTranscript, transcriptHash as hashOfTranscript } from '../../protocol/src/transcript.js';
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
      })).then((answer) => this.#keep({ roundIdBytes, entryId, entry, contract, answer,
        options: { roundRandomness: beacon.hash } }));
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
    const report = { taken: 0, refused: [], down: [], answered: 0 };
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/receipts?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) { report.down.push(`${peer}: answered ${answer.status}`); continue; }
        body = new Uint8Array(await answer.arrayBuffer());
        report.answered++;
      } catch (e) { report.down.push(`${peer}: ${e.message}`); continue; }
      for (let at = 0; at + SIGNED_RECEIPT_BYTES <= body.length; at += SIGNED_RECEIPT_BYTES) {
        try {
          this.round.takeReceipt(body.slice(at, at + SIGNED_RECEIPT_BYTES));
          report.taken++;
        } catch (e) { report.refused.push(`${peer}: ${e.message}`); }
      }
    }
    // AND ANY SEAT'S REFUSED FIRST MARK (M3.3-34): the player's own on-time first
    // mark that a seat, up, refused - checked here (round.onTimeFirstMark). It
    // shows the player started, so the close does not read a walk-away.
    report.refusedMarks = [];
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const r = await fetch(`${peer}/refused-first-mark?entry=${hex(entryIdBytes)}`);
        if (r.status !== 200) continue;
        const got = await r.json();
        const c = this.round.onTimeFirstMark(Uint8Array.from(Buffer.from(String(got.mark || ''), 'hex')));
        if (c && hex(c.entryId) === hex(entryIdBytes)) report.refusedMarks.push({ peer, why: String(got.why || '').slice(0, 120) });
      } catch { /* a seat that cannot answer shows nothing */ }
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
  //
  // §15 AT THE CLOSE (ruled 2026-09-12): A TRANSCRIPT THAT STOPS BECOMES A
  // DETERMINISTIC RESULT, never a refund. This is only ever called on a close,
  // so a run still LIVE here had its checkpoints stop before the close: it ends
  // at its last receipted checkpoint, FAILED, scored there. And an entry that
  // never started - no mark at this seat or any other, no ENTRY_VOID, no late
  // start already FORFEIT at the door - is FORFEIT, score 0, over the empty
  // receipted transcript. Measured before: both came to no result at all, and
  // the stake lock went back to the player at its expiry (no-mark-probe.mjs).
  async #keep({ roundIdBytes, entryId, entry, contract, answer, options }) {
    let canonical = null;
    let noCanonical = null;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryId); }
    catch (err) { noCanonical = err.message; }

    // A SEAT THAT COULD NOT REACH A PEER WHOSE RECEIPTS COULD LENGTHEN THE
    // RECEIPTED TRANSCRIPT cannot know that transcript, so it signs nothing and
    // waits: the finality watch tries the close again (retryClose). Measured on
    // the Daily (round a09ce9a5): seat B down at the end, seat A signed a played
    // run over the one mark it held B's receipt of, seat B later signed the same
    // run over all 94 - two transcripts, never 2 of 2, stuck. A peer whose
    // receipts could not change it (the prefix already whole, or too few seats
    // down to carry the next mark) stops nothing. An entry with no mark here
    // waits while any seat is down: that seat may hold the first mark - and so
    // does a late start's (M3.3-34, ruled): a seat holding only a late first
    // mark cannot know that a seat it cannot reach holds no on-time one.
    const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
    const down = this.#unreached(roundIdBytes, carried);
    const noMarkHere = !this.round.firstMarkHeld(roundIdBytes, entryId);
    if (down && (noMarkHere ? !this.round.entryVoid(entryId)
      : this.#mightGrow(roundIdBytes, entryId, down)))
      return { entryId, stored: false, waiting: true,
        why: `waiting on ${down} seat(s): ${(carried && carried.down.length ? carried.down.join('; ') : 'none of them answered').slice(0, 160)}`
          + `${noCanonical ? ` - ${noCanonical}` : ''}` };

    // §13C, ONE SEAT REFUSED (M3.3-34): no mark carried at the threshold, every
    // seat answered, and the seats it is short of were up and refused the
    // on-time first mark - held until the result window passes, then VOID (or
    // FORFEIT on proven equivocation), decided here once.
    if (!canonical) {
      const nq = await this.#noQuorum(roundIdBytes, entryId, contract, down);
      if (nq) return nq;
    }
    if (!canonical && this.#neverStarted(roundIdBytes, entryId)) {
      const ruled = stoppedOutcome({ receiptedMarks: 0, deadlinePassed: true });
      return this.#sign({ roundIdBytes, entryId, entry, contract,
        answer: { ok: true, outcome: ruled.outcome, score: 0 }, transcript: this.#unstarted(roundIdBytes, entryId) });
    }
    if (!answer.ok) return { entryId, stored: false, why: answer.why };
    if (!canonical) return { entryId, stored: false, why: noCanonical };
    const scored = answer.outcome === null
      ? await this.#atLastMark(roundIdBytes, entryId, entry, answer, canonical, options) : answer;
    return this.#sign({ roundIdBytes, entryId, entry, contract, answer: scored, transcript: canonical, stopped: true });
  }

  /**
   * DID THIS PLAYER NEVER START, as far as the round's seats can say? This seat
   * holds no mark of the entry, has recorded no ENTRY_VOID (§16, a first mark
   * some seat held), and every other seat answered the close's receipt pull
   * with nothing for it - a seat that is down may hold the first mark, and a
   * receipt this seat could not take is a mark it does not hold. Any doubt is
   * no FORFEIT. A LATE START IS NEVER A START (M3.3-34, ruled): its only mark
   * was refused at the door and never receipted, so it is signed FORFEIT 0
   * over the same empty transcript as no mark - at the seat that recorded the
   * late mark and at the one that never saw it alike.
   */
  /**
   * COULD SEATS THIS CLOSE COULD NOT REACH LENGTHEN THE RECEIPTED TRANSCRIPT?
   * The first mark this seat holds that is short of the round's receipts
   * decides: with `down` more receipts it would be carried. Every mark carried
   * already, nothing a missing seat holds can lengthen the prefix of marks here.
   */
  /**
   * HOW MANY OF THE ROUND'S OTHER SEATS THIS CLOSE'S RECEIPT PULL DID NOT HEAR
   * FROM: the seats seated here, less this one, less the peers that answered -
   * or the peers that were down, whichever is more. A seat that asked nobody
   * (measured: a restart ran its close before it knew its peers) heard from
   * none of them; "nobody answered" is not "nobody is missing".
   */
  #unreached(roundIdBytes, carried) {
    if (!carried) return 0;
    const others = this.round.seats(roundIdBytes).filter((s) => hex(s) !== hex(this.round.pubkey)).length;
    return Math.max(carried.down.length, others - (carried.answered || 0));
  }

  #mightGrow(roundIdBytes, entryId, down) {
    const line = this.round.startLine(roundIdBytes, entryId);
    if (!line) return false;
    for (const id of this.round.markIds(roundIdBytes, entryId)) {
      const n = this.round.receiptCount(id);
      if (n >= line.needed) continue;
      return n + down >= line.needed;
    }
    return false;
  }

  /** The empty receipted transcript of an entry that never started: what its FORFEIT is signed over and posted as. */
  #unstarted(roundIdBytes, entryId) {
    return { roundId: new Uint8Array(roundIdBytes), entryId: new Uint8Array(entryId), batches: [], marks: [] };
  }

  #neverStarted(roundIdBytes, entryId) {
    if (this.round.firstMarkHeld(roundIdBytes, entryId)) return false;
    if (this.round.entryVoid(entryId)) return false;
    const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
    return !!carried && this.#unreached(roundIdBytes, carried) === 0 && carried.refused.length === 0 && carried.taken === 0
      && !(carried.refusedMarks && carried.refusedMarks.length);
  }

  /**
   * §13C'S NO-QUORUM RULE FOR A ONE-SEAT REFUSAL (M3.3-34, ruled). The evidence,
   * on this seat's own record: it holds the player's on-time first mark with
   * fewer than the threshold's receipts, and the seats it is short of answered
   * the forward and REFUSED it (they were up - not §16's outage); or it is the
   * seat that refused (refused_first_marks) and holds no first mark. Only when
   * no seat is unreachable (a seat that cannot be reached may still carry the
   * mark: the hold goes on). Before the result window has passed - this seat's
   * close plus the round's objection window - it holds; after it, VOID, or
   * FORFEIT when the player's equivocation is proven (§13B). Not ENTRY_VOID, not
   * a late start, never a FINAL result (§14). Answers null when this is not
   * that case.
   */
  async #noQuorum(roundIdBytes, entryId, contract, down) {
    const had = this.round.noQuorum(entryId);
    if (had) return { entryId, stored: false, decided: had.outcome, why: had.why };
    if (down) return null;
    // AN OUTAGE-VOID, THEN THE PLAYER'S SECOND FIRST MARK (ruled 2026-09-12): the
    // Void stays as history and the entry is decided here like any two first
    // marks - FORFEIT after the window. A Void with no such proof stands.
    const voided = !!this.round.entryVoid(entryId);
    const line = this.round.startLine(roundIdBytes, entryId);
    if (!line) return null;
    // A LATE START IS FORFEIT 0 AT THE CLOSE (a390ca0) - unless the player also
    // signed an on-time first mark somewhere: two first marks, one parent, the
    // player's equivocation (§13B). Then no quorum is reachable and the rule's
    // answer is FORFEIT, decided here after the window like every no-quorum
    // outcome - never ENTRY_VOID (measured before: ENTRY_VOID and the lock
    // forfeited to the player at both seats).
    const lateHere = !!this.round.startForfeit(entryId);
    // ...or a proof this seat holds itself (it refused a second first mark).
    const suspect = lateHere || voided || this.round.equivocation(roundIdBytes, entryId).length > 0;
    const twoFirst = suspect ? await this.#equivocationProven(roundIdBytes, entryId) : false;
    if ((lateHere || voided) && !twoFirst) return null;
    const held = this.round.firstMarkHeld(roundIdBytes, entryId);
    let evidence;
    if (twoFirst) {
      evidence = 'the player signed two first marks for this entry - one of them late (§13B)';
    } else if (held) {
      let c;
      try { c = decodeMark(splitMark(held).body); } catch { return null; }
      if (c.tick > line.lastTick || !c.previousHash.every((x) => x === 0)) return null;
      const receipts = this.round.receiptCount(markIdOf(c));
      if (receipts >= line.needed) return null;
      const refused = Object.values(this.round.firstMarkOffers(entryId)).filter((a) => a === 'refused').length;
      if (refused < line.needed - receipts) return null;
      evidence = `the on-time first mark here has ${receipts} of ${line.needed} receipts and ${refused} seat(s) that were up refused it`;
    } else {
      // THIS SEAT REFUSED IT, or ANOTHER SEAT SHOWS IT REFUSED IT (checked in
      // this close's pull): the first mark reached only a seat that refused it,
      // and no seat holds it. Measured before: FORFEIT 0 at both seats.
      const r = this.round.refusedFirstMark(entryId);
      const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
      const shown = carried && carried.refusedMarks && carried.refusedMarks.length ? carried.refusedMarks : null;
      if (!r && !shown) return null;
      evidence = r
        ? `this seat was up, refused the player's on-time first mark (${String(r.why).slice(0, 90)}) and holds none`
        : `${shown.length} seat(s) that were up refused the player's on-time first mark (${shown[0].why.slice(0, 80)}), and no seat holds it`;
    }
    const row = this.round.get(roundIdBytes);
    const closedMs = row && row.closed_ms !== null && row.closed_ms !== undefined ? Number(row.closed_ms) : null;
    const due = closedMs === null ? null : closedMs + Number(contract.objectionWindowMs);
    if (due === null || this.round.now() < due)
      return { entryId, stored: false, waiting: true,
        why: `no quorum yet: ${evidence} - VOID only once the result window passes${due === null ? '' : ` at ${due}`}` };
    const signers = new Set(this.round.results(roundIdBytes, entryId).map((r) => hex(r.nodePubkey))).size;
    const d = noQuorumRule({ signatures: signers, needed: line.needed,
      equivocationProven: await this.#equivocationProven(roundIdBytes, entryId),
      state: finalityOf(this.round, roundIdBytes, entryId).state });
    if (!d.outcome) return null;
    this.round.putNoQuorum({ entryId, roundId: roundIdBytes, outcome: d.outcome, why: `${d.why} - ${evidence}` });
    return { entryId, stored: false, decided: d.outcome, why: d.why };
  }

  /**
   * IS THE PLAYER'S EQUIVOCATION PROVEN (§13B)? A pair of the entry's own signed
   * marks that `provesEquivocation` accepts - from this seat's store, or from
   * any seat's /equivocation door, each pair checked here and never taken on
   * a peer's word.
   */
  async #equivocationProven(roundIdBytes, entryId) {
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryId));
    if (!found) return false;
    const verify = (sig, msg, pub) => { try { return sessionCurve.verify(sig, msg, pub); } catch { return false; } };
    const pairs = this.round.equivocation(roundIdBytes, entryId).map((f) => [f.stored, f.offered]);
    // The on-time first mark this seat voided and the late one it kept: one parent, two chains.
    const voided = this.round.entryVoid(entryId);
    const late = this.round.startForfeit(entryId);
    if (voided && late) pairs.push([voided.firstMark, late.mark]);
    // THE PLAYER'S OTHER FIRST MARK, PULLED (M3.3-34, path 2): a peer's late first
    // mark, or the first mark a peer voided - paired with this seat's own first
    // mark, so a lost forward still leaves the pair to be pulled at the close.
    const mine = [voided && voided.firstMark, late && late.mark, this.round.firstMarkHeld(roundIdBytes, entryId)].filter(Boolean);
    if (mine.length) {
      for (const peer of this.peersOf(roundIdBytes)) {
        try {
          const r = await fetch(`${peer}/late-first-mark?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`);
          if (r.status === 200) { const theirs = new Uint8Array(await r.arrayBuffer()); for (const m of mine) pairs.push([m, theirs]); }
        } catch { /* a seat that cannot answer proves nothing */ }
        try {
          const r = await fetch(`${peer}/entry-void?entry=${hex(entryId)}`);
          if (r.status === 200) {
            const got = await r.json();
            if (got.firstMark) { const theirs = Uint8Array.from(Buffer.from(String(got.firstMark), 'hex')); for (const m of mine) pairs.push([m, theirs]); }
          }
        } catch { /* a seat that cannot answer proves nothing */ }
      }
    }
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const r = await fetch(`${peer}/equivocation?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`);
        if (r.status !== 200) continue;
        const body = new Uint8Array(await r.arrayBuffer());
        for (let at = 0; at + 2 * SIGNED_MARK_BYTES <= body.length; at += 2 * SIGNED_MARK_BYTES)
          pairs.push([body.slice(at, at + SIGNED_MARK_BYTES), body.slice(at + SIGNED_MARK_BYTES, at + 2 * SIGNED_MARK_BYTES)]);
      } catch { /* a seat that cannot answer proves nothing */ }
    }
    for (const [a, b] of pairs) {
      try {
        if ((await provesEquivocation(a, b, found.entry.sessionPubkey, verify)).ok) {
          // A PULLED PAIR OF FIRST MARKS IS KEPT HERE TOO, so this seat's own
          // record (its forfeit door, its close) says two first marks from now on.
          this.round.putFirstMarkPair({ a, b });
          return true;
        }
      } catch { /* not a proof */ }
    }
    return false;
  }

  /**
   * THE REPLAY AT THE LAST RECEIPTED CHECKPOINT of a run the close found LIVE:
   * where §15 says the valid run ends. Ticks this seat stored past that mark
   * were never carried, so they are replayed away - the prefix alone is
   * submitted to the same pool - and when there are none the answer stands.
   */
  async #atLastMark(roundIdBytes, entryId, entry, answer, canonical, options) {
    const last = canonical.throughTick;
    if (!Number.isInteger(last)) return answer;
    const full = this.round.transcript(roundIdBytes, entryId);
    const reach = full.ticks.length ? full.ticks[full.ticks.length - 1].tick + 1 : entry.joinTick;
    if (reach <= last) return answer;
    const prefix = { ticks: full.ticks.filter((t) => t.tick < last),
      liquidations: full.liquidations.filter((l) => l[0] < last), loads: full.loads.filter((l) => l[0] < last) };
    return this.pool.submit({ key: `${hex(roundIdBytes)}:${hex(entryId)}:stopped`, objected: false,
      transcript: prefix, entry, options });
  }

  #sign({ roundIdBytes, entryId, entry, contract, answer, transcript, stopped = false }) {
    const built = resultFrom({
      answer, contract, entry, transcript, entryId,
      nodePubkey: this.round.pubkey, stopped,
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
   * THE CLOSE, ONCE MORE, FOR A RUN THIS SEAT COULD NOT SIGN AT ITS CLOSE
   * (M3.3-34, the Daily's close). A seat whose peer was down or unreachable at
   * the close could not pull that peer's receipts, so it could neither form the
   * receipted transcript of a run that played nor tell that no seat held a
   * walk-away's first mark - it signed nothing, and nothing asked again.
   * Measured: both runs silent at the live seat. The finality watch calls this
   * on its cadence: the cheap pull first, and only once every peer answered,
   * the same replay and signature the close makes. Until then it is waiting -
   * never a refund, never a VOID.
   */
  async retryClose(roundIdBytes, entryIdBytes) {
    // A RUN THIS SEAT HAS SIGNED IS NOT CLOSED AGAIN (as `retry`): one seat, one result.
    if (this.round.hasResult(roundIdBytes, entryIdBytes, this.round.pubkey))
      return { entryId: entryIdBytes, stored: false, why: 'this seat has already signed this run' };
    const row = this.round.get(roundIdBytes);
    if (!row) return { entryId: entryIdBytes, stored: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return { entryId: entryIdBytes, stored: false, why: 'no such entry in that round' };
    const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry, entryIdBytes, this.chainFor);
    if (!beacon.ok) return { entryId: entryIdBytes, stored: false, why: beacon.why };
    const carried = await this.carryReceipts(roundIdBytes, entryIdBytes);
    // THE CHEAP ANSWER FIRST: still waiting on a seat that matters, no replay.
    const noMarkHere = !this.round.firstMarkHeld(roundIdBytes, entryIdBytes);
    const down = this.#unreached(roundIdBytes, carried);
    if (down && (noMarkHere || this.#mightGrow(roundIdBytes, entryIdBytes, down)))
      return { entryId: entryIdBytes, stored: false, waiting: true,
        why: `waiting on ${down} seat(s): ${(carried.down.length ? carried.down.join('; ') : 'none of them answered').slice(0, 160)}` };
    const options = { roundRandomness: beacon.hash };
    const answer = await this.pool.submit({ key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:retry:${++retryJobs}`,
      objected: this.round.objected(roundIdBytes, entryIdBytes),
      transcript: this.round.transcript(roundIdBytes, entryIdBytes), entry: found.entry, options });
    return this.#keep({ roundIdBytes, entryId: entryIdBytes, entry: found.entry, contract, answer, options });
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
        // A RE-RUN IS AFTER THE CLOSE TOO: a run LIVE at its last receipted
        // mark is the same FAILED the close signed (§15, ruled 2026-09-12).
        const scored = canonical && answer.outcome === null
          ? await this.#atLastMark(roundIdBytes, entryIdBytes, found.entry, answer, canonical, { roundRandomness: beacon.hash })
          : answer;
        const built = canonical && resultFrom({
          answer: scored, contract, entry: found.entry, transcript: canonical, entryId: entryIdBytes,
          nodePubkey: this.round.pubkey, stopped: true,
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
    // AN ENTRY THAT NEVER STARTED (§15 at the close): its FORFEIT names the empty
    // receipted transcript, which every seat builds alike and none holds as marks.
    const empty = this.#unstarted(roundIdBytes, entryIdBytes);
    if (hex(hashOfTranscript(empty)) === hex(transcriptHash)) return encodeTranscript(empty);
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
