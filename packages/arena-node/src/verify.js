// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { sandboxFor } from './core-sandbox.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { dissentsOn, dissentsFirstOn, postsLateOn, LATE_POSTING_AFTER_MS } from './test-dissent.js';
import { ReplayPool } from './pool.js';
import { checkObjectionBundle } from './objection-check.js';
import { decodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { sha256 } from '../../arena-protocol/src/hash.js';
import { stateOf } from './settlement-state.js';
import { verifyKept } from './verify-kept.js';
import { timed } from './slow.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { resultFrom, signResult, verifiedFinal, runId } from './verdict.js';
import { stoppedOutcome } from '../../arena-protocol/src/first-mark.js';
import { noQuorumOutcome as noQuorumRule } from '../../arena-protocol/src/payout.js';
import {
  provesEquivocation, SIGNED_CHECKPOINT_BYTES as SIGNED_MARK_BYTES, splitSigned as splitMark,
  decodeCheckpoint as decodeMark, checkpointId as markIdOf,
} from '../../arena-protocol/src/checkpoint.js';
import { ed25519 as sessionCurve } from '@noble/curves/ed25519.js';
import { resultFinality as finalityOf, chainIndex, resultWindow } from './finality.js';

let retryJobs = 0;                     // each re-tried close is its own pool job
let objectionJobs = 0;                 // each objection's replay is its own pool job (§13A)
import { encodeTranscript, transcriptHash as hashOfTranscript } from '../../arena-protocol/src/transcript.js';
import { TRANSCRIPT_BATCH_MAX_BYTES } from './round.js';
import {
  encodeTranscriptPosting, transcriptPostingId, joinSignedPosting, splitSignedPosting, decodeTranscriptPosting,
  transcriptBytesHash, relayPath, transcriptIsPublished, SIGNED_POSTING_BYTES,
} from '../../arena-protocol/src/posting.js';
import {
  encodeRerunResult, rerunResultId, joinSignedRerun, splitSignedRerun, decodeRerunResult, rerunIsAgreed,
  SIGNED_RERUN_BYTES, runOf, cutSignedReruns,
} from '../../arena-protocol/src/rerun.js';
import { encodeSlashProof, slashProofId, slashHolds, joinSlashEvidence, slashHoldsOnRerun, joinRerunSlashEvidence } from '../../arena-protocol/src/slash.js';
import {
  joinSignedResult, splitSignedResult, decodePlayerResult, resultId, SIGNED_RESULT_BYTES, cutSignedResults,
  encodePlayerResult,
} from '../../arena-protocol/src/result.js';
import { decodeRoundContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { headToHeadResults, headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';
import { splitSigned as splitSignedMark, decodeCheckpoint, checkpointId, SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';
import { pluginForRound, hostedPlugins, itemUnlocksOf } from './plugins.js';

/** Why an attested round's entry is not closed, gathered or signed as a run (§0A.7a). */
const ATTESTED_NO_RUN = 'that round\'s game is attested: its result is its attestors\' outcome (GET /outcome), not a run - nothing of it is replayed';
import { committeeSeedFromBeacon, beaconFromChain, beaconIsTheChains } from '../../arena-protocol/src/beacon.js';
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
/**
 * THE HEADERS OF A VIEW, BUILT ONCE PER VIEW (2026-09-17 19:15, the ghost lag). A view of an old round reaches
 * from twenty below its census to the tip - twenty thousand blocks on the Daily - and this used to lay out its
 * headers again on every ask. Measured live: the finality watch's retry of ONE old round held the loop a median
 * 305 ms, 255 times in eight minutes, and that is the thread another player's truck is drawn from. The view object
 * is the same object while it is the same view, so its headers are kept beside it and go when it does.
 */
const headersOfView = new WeakMap();
const headersOf = (view) => {
  let had = headersOfView.get(view);
  if (!had || had.blocks !== view.blocks.length) {
    had = { blocks: view.blocks.length, headers: { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight } };
    headersOfView.set(view, had);
  }
  return had.headers;
};

/**
 * And the answer that scan gives, per round, per view START and per beacon - never per block count.
 *
 * Keyed on the count, it was thrown away every time the chain moved: measured live, one old round's finality retry
 * still rescanned twenty thousand headers and held the loop 605 ms twice in six minutes, which is the 635 ms the other
 * player's truck was late by. A beacon is the first block after the round's committee time, so a view that reaches it
 * gives the same answer however much more chain arrives after it. ONLY A PASS IS KEPT: a refusal may be a view that
 * has not reached the beacon yet, and that one is asked again.
 */
const beaconChecks = new Map();

function beaconFor(randomnessFor, contract, roundIdBytes, entry, entryId, chainFor) {
  const given = randomnessFor({ contract, roundIdBytes, entry, entryId });
  const hash = given && (given.hash || (given instanceof Uint8Array ? given : undefined));
  const height = given && given.height;
  const seeded = committeeSeedFromBeacon(contract, {
    roundId: roundIdBytes, randomness: hash, height, timeMs: given && given.timeMs,
  });
  if (!seeded.ok) return seeded;

  // AND AGAINST THIS NODE'S OWN CHAIN, exactly as the roster asks at joining.
  //
  // 27's rule is all `committeeSeedFromBeacon` can ask - it has no chain - and
  // "after committee_time" is not "the block the chain names". The beacon here
  // is not idle: `replay` derives every player's world from it, so a node
  // closing on a late-but-wrong block computes a different world, a different
  // state hash and a result no honest node will agree with. The same door the
  // signer node goes through, for the same reason.
  //
  // A node with no view is left as it was: it has no chain to ask, 27's rule
  // has already run, and refusing here would refuse every node that closes
  // without one.
  const view = chainFor ? chainFor({ contract, roundIdBytes }) : null;
  // A VIEW STILL BEING READ IS NOT A VIEW, AND NOT "NO CHAIN" EITHER: this node has a chain and has not read this
  // round's part of it yet, so it says so and is asked again rather than passing the beacon unchecked.
  if (view && view.pending)
    return { ok: false, why: 'this node is still reading its chain view for that round' };
  if (view && Array.isArray(view.blocks) && view.blocks.length) {
    const key = `${hex(roundIdBytes)}:${view.firstHeight}:${hash ? hex(hash) : 'none'}:${height}`;
    if (!beaconChecks.has(key)) {
      const headers = headersOf(view);
      const named = beaconFromChain(contract, headers);
      if (!named.ok) return named;
      const agrees = beaconIsTheChains(contract, { hash, height, timeMs: given && given.timeMs }, headers);
      if (!agrees.ok) return agrees;
      beaconChecks.set(key, true);
      if (beaconChecks.size > 64) beaconChecks.delete(beaconChecks.keys().next().value);
    }
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

/** How long a signer node waits on a peer's `/results` before it treats that peer as down for this pass. */
const PEER_WAIT_MS = 2500;

export class Verifier {
  constructor(round, {
    randomnessFor = NO_RANDOMNESS_SOURCE, chainFor = null, pool = new ReplayPool(), peers = [],
    peersFor = null, advertsFor = null, plugins = [], conflictsFor = null,
  } = {}) {
    // `conflictsFor` is no longer consulted (§5A.13, ruled 2026-10-14): no player declares an operator
    this.conflictsFor = conflictsFor;
    // THE GAMES THIS NODE HOSTS (M3 R1): a round's runs are replayed by the core its game installed, or not at all.
    this.plugins = hostedPlugins(plugins);
    /**
     * THE SIGNER NODES' OWN ADVERTISEMENTS, by round: a Map of node key (hex) to the
     * decoded advertisement, whose bond outpoint a slash proof must name. The
     * daemon passes its census's (5A.2 resolves the bodies out of the blocks).
     */
    this.advertsFor = advertsFor;
    /**
     * THE OTHER SIGNER NODES OF ONE ROUND, when the operator named none: a function
     * of the round, because a committee is a round's. The daemon passes the
     * census's own addresses - the signed advertisement in each signer node's bond -
     * which is the record signer node selection already reads. Measured on the regtest
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
     * THE OTHER SIGNER NODES, as base URLs. A node's committee is named in the round
     * contract by KEY, and a key is not an address: 25.1 makes finding an
     * address discovery's job, which is not this letter's. So the operator
     * says where its peers are and the CONTRACT still says whose signatures
     * count - a peer that is not on the committee can answer all it likes and
     * still not be a signer node.
     */
    this.peers = peers;
    /** The committee seed each closed round derived, by round id. */
    this.seeds = new Map();
    this.pool = pool;
    /** What the last close produced, so a caller can wait for it or read it. */
    this.done = [];
    /** What it QUEUED, and how - so a node can be asked what it thought it had. */
    this.queued = [];
    // THE OBJECTION DOOR'S BOUNDS (audit): one check in flight per entry, and each replayed run kept by its bytes
    this.objectionTurns = new Map();
    this.objectionReplays = new Map();
    this.objectionReplayCount = 0;
    this.latePostingSaid = new Set();
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
    // AN ATTESTED ROUND HAS NO RUN TO REPLAY (§0A.7a): its result is its attestors' outcome (POST /outcome),
    // so its close queues nothing - no beacon, no receipts, no worker
    if (this.#attested(contract)) { this.queued = []; return []; }
    // A HEAD-TO-HEAD ROUND HAS NO RUN EITHER: its close is its reveal deadline, and every entry's result is
    // decided over all the round's reveals at once - by the game's decide adapter - then signed as a replayed result is
    const h2h = this.#headToHead(contract);
    if (h2h) { this.queued = []; const work = this.#headToHeadClose(roundIdBytes, contract, h2h); this.done = work; return work; }

    this.queued = [];
    const work = this.round.entriesOf(roundIdBytes).map(({ entryId, entry }) => {
      // THE BEACON BEFORE THE REPLAY. A round whose committee could have been
      // ground is not a round to spend a worker on, and it is certainly not
      // one to sign a result for.
      const beacon = timed(`close beacon ${hex(entryId).slice(0, 8)}`,
        () => beaconFor(this.randomnessFor, contract, roundIdBytes, entry, entryId, this.chainFor), { over: 20 });
      if (!beacon.ok) {
        this.queued.push({ entryId, objected: false, refused: beacon.why });
        return Promise.resolve({ entryId, stored: false, why: beacon.why });
      }
      this.seeds.set(hex(roundIdBytes), beacon.committeeSeed);

      // THE WORKER READS THE RUN WHEN THERE IS A FILE TO READ IT FROM (2026-09-17 19:15): this loop feeds
      // pictured trucks, and a stored run's rows are not its work. A store with no file - a test's ':memory:' - is
      // read here as before.
      const run = this.#runFor(roundIdBytes, entryId);
      const objected = this.round.objected(roundIdBytes, entryId);
      this.queued.push({ entryId, objected });
      // THE PEERS' RECEIPTS BEFORE THE CANONICAL CHAIN IS TAKEN (13C). Each
      // signer node receipts a mark itself and keeps only its own half, so a node
      // that asked nobody could never hold T of them. Pulled here, by the
      // node, and not trusted to the client: a losing player who withheld
      // receipts would reach no-quorum and a VOID refund.
      return timed(`close carryReceipts ${hex(entryId).slice(0, 8)}`, () => this.carryReceipts(roundIdBytes, entryId))
        .then(() => timed(`close hand to worker ${hex(entryId).slice(0, 8)}`, () => this.pool.submit({ core: this.#coreOf(roundIdBytes),
        key: `${hex(roundIdBytes)}:${hex(entryId)}`,
        objected,
        ...run,
        entry,
        // The WORLD seed's half of the same published value.
        options: { roundRandomness: beacon.hash },
      }))).then((answer) => timed(`close keep and sign ${hex(entryId).slice(0, 8)}`,
        () => this.#keep({ roundIdBytes, entryId, entry, contract, answer,
          options: { roundRandomness: beacon.hash } }), { over: 20 }));
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
   * mark is one this node holds, the signer is assigned to this round, and the
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
      // THE RECEIPTS A PEER SENT, TAKEN INTO THE STORE - the continuation after that peer answered, and the last
      // unnamed one on this chain (2026-09-17 19:15, the ghost lag): stalls of 299-377 ms named only 6-9 ms of
      // frame work and left 190-250 ms of this thread's processor unaccounted. Each receipt is checked and written
      // here, per peer, per entry, at the close and at every retry.
      timed(`close take receipts ${hex(entryIdBytes).slice(0, 8)}`, () => {
        for (let at = 0; at + SIGNED_RECEIPT_BYTES <= body.length; at += SIGNED_RECEIPT_BYTES) {
          try {
            this.round.takeReceipt(body.slice(at, at + SIGNED_RECEIPT_BYTES));
            report.taken++;
          } catch (e) { report.refused.push(`${peer}: ${e.message}`); }
        }
      }, { over: 20 });
    }
    // AND ANY SIGNER NODE'S REFUSED FIRST MARK (M3.3-34): the player's own on-time first
    // mark that a signer node, up, refused - checked here (round.onTimeFirstMark). It
    // shows the player started, so the close does not read a walk-away.
    report.refusedMarks = [];
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const r = await fetch(`${peer}/refused-first-mark?entry=${hex(entryIdBytes)}`);
        if (r.status !== 200) continue;
        const got = await r.json();
        const c = this.round.onTimeFirstMark(Uint8Array.from(Buffer.from(String(got.mark || ''), 'hex')));
        if (c && hex(c.entryId) === hex(entryIdBytes)) report.refusedMarks.push({ peer, why: String(got.why || '').slice(0, 120), markId: markIdOf(c) });
      } catch { /* a signer node that cannot answer shows nothing */ }
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
  // never started - no mark at this signer node or any other, no ENTRY_VOID, no late
  // start already FORFEIT at the door - is FORFEIT, score 0, over the empty
  // receipted transcript. Measured before: both came to no result at all, and
  // the stake lock went back to the player at its expiry (no-mark-probe.mjs).
  async #keep(args) {
    return timed(`close keep ${hex(args.entryId).slice(0, 8)}`, () => this.#kept(args), { over: 20 });
  }

  async #kept({ roundIdBytes, entryId, entry, contract, answer, options }) {
    let canonical = null;
    let noCanonical = null;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryId); }
    catch (err) { noCanonical = err.message; }

    // A SIGNER NODE THAT COULD NOT REACH A PEER WHOSE RECEIPTS COULD LENGTHEN THE
    // RECEIPTED TRANSCRIPT cannot know that transcript, so it signs nothing and
    // waits: the finality watch tries the close again (retryClose). Measured on
    // the Daily (round a09ce9a5): signer node B down at the end, signer node A signed a played
    // run over the one mark it held B's receipt of, signer node B later signed the same
    // run over all 94 - two transcripts, never 2 of 2, stuck. A peer whose
    // receipts could not change it (the prefix already whole, or too few signer nodes
    // down to carry the next mark) stops nothing. An entry with no mark here
    // waits while any signer node is down: that signer node may hold the first mark - and so
    // does a late start's (M3.3-34, ruled): a signer node holding only a late first
    // mark cannot know that a signer node it cannot reach holds no on-time one.
    const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
    const down = this.#unreached(roundIdBytes, carried);
    const noMarkHere = !this.round.firstMarkHeld(roundIdBytes, entryId);
    // A PROOF OF TWO FIRST MARKS HELD HERE waits on nobody (§13B; M3.3-34, a
    // signer node that stays down): no transcript a down signer node holds can unmake it.
    if (down && !this.round.provenTwoFirstMarks(roundIdBytes, entryId) && (noMarkHere ? !this.round.entryVoid(entryId)
      : this.#mightGrow(roundIdBytes, entryId, down))) {
      const why = `waiting on ${down} signer node(s): ${(carried && carried.down.length ? carried.down.join('; ') : 'none of them answered').slice(0, 160)}`
        + `${noCanonical ? ` - ${noCanonical}` : ''}`;
      // PAST THE RESULT WINDOW, still unable to retrieve the transcript: §13C decides (07:49).
      return (await this.#unretrievedPastWindow(roundIdBytes, entryId, contract, why)) || { entryId, stored: false, waiting: true, why };
    }

    // §13C, ONE SIGNER NODE REFUSED (M3.3-34): no mark carried at the threshold, every
    // signer node answered, and the signer nodes it is short of were up and refused the
    // on-time first mark - held until the result window passes, then VOID (or
    // FORFEIT on proven equivocation), decided here once.
    // §13B BEFORE ANY RESULT: a signer node holding the proof of two first marks signs
    // no run for that entry - the no-quorum rule decides it FORFEIT after the
    // window. Measured before on 5 of 7 (an outage-VOID, a second first mark,
    // the one signer node that refused it down): six signer nodes signed FAILED over a
    // transcript the late-taken first mark made canonical - four of them holding
    // the proof - the results never agreed, no signer node settled, and the hold went
    // back to the player at its expiry (98000 msat).
    const voided = !!this.round.entryVoid(entryId);
    if (!canonical || voided || this.round.provenTwoFirstMarks(roundIdBytes, entryId)) {
      const nq = await this.#noQuorum(roundIdBytes, entryId, contract, down);
      if (nq) return nq;
    }
    // AN ENTRY THIS SIGNER NODE HOLDS ENTRY_VOID (§16) GETS NO RUN SIGNED HERE (M3.3-34,
    // ruled 2026-09-13): two first marks stay FORFEIT (the no-quorum rule just
    // above); anything else is the Void. Measured before on 5 of 7: signer nodes 0-3
    // voided on a real outage, the down signer nodes were caught up late, and all seven
    // signed FAILED over the late-carried mark - the hold settled into the pool.
    if (voided && !this.round.provenTwoFirstMarks(roundIdBytes, entryId))
      return { entryId, stored: false, why: 'this signer node holds the entry ENTRY_VOID (§16): it signs no run for it' };
    if (!canonical && this.#neverStarted(roundIdBytes, entryId)) {
      const ruled = stoppedOutcome({ receiptedMarks: 0, deadlinePassed: true });
      return this.#sign({ roundIdBytes, entryId, entry, contract,
        // No core is stepped for a run that never started - §15 rules it over the empty transcript - so the
        // answer names the core this signer node holds for the round (M3 R1): a signer node that holds none signs nothing.
        answer: { ok: true, outcome: ruled.outcome, score: 0, coreHash: this.#coreOf(roundIdBytes)?.hash },
        transcript: this.#unstarted(roundIdBytes, entryId) });
    }
    if (!answer.ok) return { entryId, stored: false, why: answer.why };
    if (!canonical) return { entryId, stored: false, why: noCanonical };
    // §13B AT ANY TICK (RULED 2026-10-04): "a player who publishes two different checkpoints for the
    // same tick, or two chains that diverge at any tick, forfeits the entry". Before signing the run, this seat looks for
    // the proof - its own store, and every peer's /equivocation pulled and checked (provesEquivocation, unchanged; a fork
    // sent to different seats reaches each) - and holding it signs FORFEIT, score 0, over the canonical transcript, not
    // the run. Before: only two FIRST marks diverted; a fork at a later tick was stored and the run signed as ever.
    {
      if (!this.round.provenFork(roundIdBytes, entryId)) await this.#equivocationProven(roundIdBytes, entryId);
      if (!this.round.provenFork(roundIdBytes, entryId)) await this.#forkFromPeers(roundIdBytes, entryId, entry.sessionPubkey);
      const fork = this.round.provenFork(roundIdBytes, entryId);
      if (fork) {
        console.log(`[close] ${hex(entryId).slice(0, 16)} FORFEIT: two chains at tick ${fork.tick} (§13B)`);
        return this.#sign({ roundIdBytes, entryId, entry, contract,
          answer: { ok: true, outcome: 'FORFEIT', score: 0, coreHash: this.#coreOf(roundIdBytes)?.hash },
          transcript: canonical, stopped: true });
      }
    }
    // A HELD-BACK FINAL MARK (ruled 2026-09-23): a run that would be signed as a stopped transcript, while a peer
    // holds the run's final mark over inputs this signer node is short of, is not signed yet - its close does not
    // end the window; the settlement's combine does. Only this case; every other stopped run is signed as ever.
    // ONE CHECK, WHATEVER THE REPLAY SAID (ruled 2026-09-24): a DELIVERED signature is over the transcript that holds
    // the final mark, so a node short the mark - its inputs short or whole - does not sign until it has it.
    const held = await this.#holdBack(roundIdBytes, entryId, entry);
    if (held && !held.signStopped) return held;
    // THE COMBINE CAME FIRST while this node still lacked the final mark: the stopped transcript is signed - never a
    // DELIVERED over a transcript without the mark (ruled 2026-09-23/24).
    if (held && held.signStopped) {
      const stoppedAt = await this.#atLastMark(roundIdBytes, entryId, entry, { ...answer, outcome: null }, canonical, options);
      return this.#sign({ roundIdBytes, entryId, entry, contract, answer: stoppedAt, transcript: canonical, stopped: true });
    }
    // AND THE SIGNER NODE THAT HOLDS THE FINAL MARK'S ASK, while that mark is not yet carried because a peer is short
    // of its inputs: its close does not end the window either, so both sign over the same transcript (measured: A
    // signed at its close without the final mark, B after its catch-up with it - two hashes, never 2 of 2). Only the
    // run's final mark (the end of the inputs held here), only until the settlement is combined.
    // A DELIVERED RUN ONLY: a player who kept its last inputs from one node would otherwise hold a pair of nodes open on
    // a run it lost (§15: closing the browser does not escape a losing stake).
    const pendingFinal = answer.outcome === 'DELIVERED' ? this.round.pendingFinalMark(roundIdBytes, entryId) : null;
    if (pendingFinal) {
      if (!(await this.#combined(roundIdBytes)))
        return { entryId, stored: false, waiting: true, heldBack: true,
          why: `holding back the close: the run's final mark at tick ${pendingFinal.tick} is carried by ${pendingFinal.receipts} of the ${pendingFinal.need} it needs` };
    }
    const scored = answer.outcome === null
      ? await this.#atLastMark(roundIdBytes, entryId, entry, answer, canonical, options) : answer;
    return this.#sign({ roundIdBytes, entryId, entry, contract, answer: scored, transcript: canonical, stopped: true });
  }

  /**
   * A FORK SENT TO DIFFERENT SEATS (§13B;: "A fork sent to different seats still reaches both"). A player who
   * sends mark X only here and a different mark Y at the same tick (or from the same parent) only to a peer leaves no
   * seat holding both - so no seat's /equivocation has the pair to pull. Each peer's receipted marks (GET /checkpoints)
   * are set against this seat's own: a mark at the same tick, or naming the same parent, with another id, checked by
   * provesEquivocation unchanged, is kept as a fork pair (served at /equivocation from then on). Nothing else is taken.
   */
  async #forkFromPeers(roundIdBytes, entryId, sessionPubkey) {
    const mineBytes = this.round.checkpoints(roundIdBytes, entryId).bytes;
    const mine = [];
    for (let at = 0; at + SIGNED_MARK_BYTES <= mineBytes.length; at += SIGNED_MARK_BYTES) {
      const b = mineBytes.slice(at, at + SIGNED_MARK_BYTES);
      try { mine.push({ bytes: b, c: decodeCheckpoint(splitSignedMark(b).body) }); } catch { /* not a mark */ }
    }
    if (!mine.length) return false;
    const verify = (sig, msg, pub) => { try { return sessionCurve.verify(sig, msg, pub); } catch { return false; } };
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const r = await fetch(`${peer}/checkpoints?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`);
        if (!r.ok) continue;
        body = new Uint8Array(await r.arrayBuffer());
      } catch { continue; }                  // a peer that is down proves nothing
      for (let at = 0; at + SIGNED_MARK_BYTES <= body.length; at += SIGNED_MARK_BYTES) {
        const theirs = body.slice(at, at + SIGNED_MARK_BYTES);
        let tc; try { tc = decodeCheckpoint(splitSignedMark(theirs).body); } catch { continue; }
        for (const m of mine) {
          if (hex(m.bytes) === hex(theirs)) continue;
          if (m.c.tick !== tc.tick && hex(m.c.previousHash) !== hex(tc.previousHash)) continue;
          try {
            // both receipted: this seat's own chain, and the peer's receipted chain it serves
            if ((await provesEquivocation(m.bytes, theirs, sessionPubkey, verify)).ok && this.round.putForkPair({ a: m.bytes, b: theirs, receipted: true })) {
              console.log(`[equivocation] ${hex(entryId).slice(0, 16)}: a fork at tick ${Math.min(m.c.tick, tc.tick)} - this seat's mark and ${peer}'s, kept as a pair`);
              return true;
            }
          } catch { /* not a proof */ }
        }
      }
    }
    return false;
  }

  /**
   * HOLD BACK THIS RUN'S CLOSE-TIME RESULT? Only when a peer's receipts named a mark this node has not got (the close's
   * own pull) and that mark is at a peer - signed by the entry's session key, chained onto a mark this node holds -
   * whether this node is short of the inputs before its tick or short only the mark (ruled 2026-09-24: measured on
   * 5 of 7, a node whose batches landed just before its close signed DELIVERED without the mark). Then the mark is kept (`putHeldFinalAsk`) and the doors take
   * its batches and it, feed first, until the run can be replayed whole. Not once the settlement is combined: then the
   * stopped transcript is signed and the doors shut. Answers the held answer, or null to sign as ever.
   */
  async #holdBack(roundIdBytes, entryId, entry) {
    if (await this.#combined(roundIdBytes)) {
      const kept = this.round.heldFinalAsk(entryId);
      if (!kept) return null;
      this.round.dropHeldFinalAsk(entryId);            // the window ended: the doors shut
      const markHere = this.round.holdsMark(checkpointId(decodeCheckpoint(splitSignedMark(kept.mark).body)));
      return markHere ? null : { signStopped: true };
    }
    let ask = this.round.heldFinalAsk(entryId);
    if (!ask) {
      const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
      if (!carried || !carried.refused.some((r) => /a mark this node has not got/.test(r))) return null;
      ask = await this.#peerFinalMark(roundIdBytes, entryId, entry);
      if (!ask) return null;
      this.round.putHeldFinalAsk({ roundId: roundIdBytes, entryId, mark: ask.mark, tick: ask.tick });
    }
    // THE MARK IN, AND ITS INPUTS: the hold is done - the doors shut, and the run is signed over the transcript with it.
    const have = this.round.heldInputTicks(roundIdBytes, entryId);
    if (this.round.holdsMark(checkpointId(decodeCheckpoint(splitSignedMark(ask.mark).body))) && have >= ask.tick) {
      this.round.dropHeldFinalAsk(entryId);
      return null;
    }
    return { entryId, stored: false, waiting: true, heldBack: true,
      why: `holding back the close: a peer holds the run's final mark at tick ${ask.tick}; this signer node holds inputs `
        + `through ${have}${have >= ask.tick ? ' (whole) and not the mark' : ''}` };
  }

  /**
   * IS THE ROUND'S SETTLEMENT COMBINED? This node's own row - or, for a node that was down across it (measured: B came
   * back after the combine, held its close for ever and never signed), a peer's row whose combined signature verifies
   * under the round's claim key over the message it names (`combinedElsewhere`, the server's): only a threshold of the
   * round's signer nodes can make one, so a peer's word alone ends nothing.
   */
  async #combined(roundIdBytes) {
    const st = stateOf(this.round, roundIdBytes);
    if (st === 'SUBMITTING' || st === 'ACCEPTED') return true;
    if (typeof this.combinedElsewhere !== 'function') return false;
    try { return !!(await this.combinedElsewhere(roundIdBytes)); } catch { return false; }
  }

  /** The mark a peer holds past this node's chain - checked, never believed. */
  async #peerFinalMark(roundIdBytes, entryId, entry) {
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const r = await fetch(`${peer}/checkpoints?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`);
        if (!r.ok) continue;
        body = new Uint8Array(await r.arrayBuffer());
      } catch { continue; }
      for (let at = 0; at + SIGNED_CHECKPOINT_BYTES <= body.length; at += SIGNED_CHECKPOINT_BYTES) {
        const bytes = body.slice(at, at + SIGNED_CHECKPOINT_BYTES);
        let c; let sig;
        try { const x = splitSignedMark(bytes); c = decodeCheckpoint(x.body); sig = x.signature; } catch { continue; }
        if (hex(c.entryId) !== hex(entryId) || hex(c.roundId) !== hex(roundIdBytes)) continue;
        const id = checkpointId(c);
        if (this.round.holdsMark(id) || !this.round.holdsMark(c.previousHash)) continue;
        let ok = false;
        try { ok = sessionCurve.verify(sig, id, entry.sessionPubkey); } catch { ok = false; }
        if (!ok) continue;
        return { mark: bytes, tick: c.tick };
      }
    }
    return null;
  }

  /**
   * DID THIS PLAYER NEVER START, as far as the round's signer nodes can say? This signer node
   * holds no mark of the entry, has recorded no ENTRY_VOID (§16, a first mark
   * some signer node held), and every other signer node answered the close's receipt pull
   * with nothing for it - a signer node that is down may hold the first mark, and a
   * receipt this signer node could not take is a mark it does not hold. Any doubt is
   * no FORFEIT. A LATE START IS NEVER A START (M3.3-34, ruled): its only mark
   * was refused at the door and never receipted, so it is signed FORFEIT 0
   * over the same empty transcript as no mark - at the signer node that recorded the
   * late mark and at the one that never saw it alike.
   */
  /**
   * COULD SIGNER NODES THIS CLOSE COULD NOT REACH LENGTHEN THE RECEIPTED TRANSCRIPT?
   * The first mark this signer node holds that is short of the round's receipts
   * decides: with `down` more receipts it would be carried. Every mark carried
   * already, nothing a missing signer node holds can lengthen the prefix of marks here.
   */
  /**
   * HOW MANY OF THE ROUND'S OTHER SIGNER NODES THIS CLOSE'S RECEIPT PULL DID NOT HEAR
   * FROM: the signer nodes joined here, less this one, less the peers that answered -
   * or the peers that were down, whichever is more. A signer node that asked nobody
   * (measured: a restart ran its close before it knew its peers) heard from
   * none of them; "nobody answered" is not "nobody is missing".
   */
  #unreached(roundIdBytes, carried) {
    if (!carried) return 0;
    const others = this.round.signerNodes(roundIdBytes).filter((s) => hex(s) !== hex(this.round.pubkey)).length;
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
   * THE CORE A ROUND'S RUNS ARE REPLAYED UNDER (M3 R1): the one its contract names, as this signer node's
   * plugins.js resolves it - or none, and the replay refuses (replay.js NO_CORE_RULE).
   */
  /** Is this round's game attested (§0A.7a)? Then nothing of it is replayed, gathered or signed as a run here. */
  #headToHead(contract) {
    const found = pluginForRound(contract, this.plugins);
    return found.ok && found.headToHead === true ? found : null;
  }

  /**
   * A HEAD-TO-HEAD ROUND'S CLOSE: the other seats' reveals first (so every seat decides from the same moves),
   * then the game's decide over all of them (head-to-head.js headToHeadResults: WIN / DRAW / LOSS onto the payout rule,
   * FORFEIT for no reveal), then one signed result per entry through #sign - its transcript hash the digest of the entry's
   * reveal (32 zero bytes for none), its core the round's decide adapter. One promise per entry, as a replayed close.
   */
  #headToHeadClose(roundIdBytes, contract, found) {
    const entries = this.round.entriesOf(roundIdBytes);
    const decided = (async () => {
      await this.carryReveals(roundIdBytes, entries, found.plugin.manifest.moveCount);
      const held = new Map(this.round.revealsOf(roundIdBytes).map((r) => [hex(r.entryId), r]));
      const list = entries.map(({ entryId }) => { const r = held.get(hex(entryId)); return { key: hex(entryId), move: r ? r.move : null }; });
      // DECIDED IN THE CORE'S SANDBOX (§0A.6): the moves in as JSON, the verdicts out as JSON
      let box = null;
      try { box = found.core ? sandboxFor(found.core) : null; } catch (e) { throw new Error(`game "${found.plugin.manifest.gameName}"'s decide adapter does not load in its sandbox: ${e.message}`); }
      if (!box || !box.meta.decide) throw new Error(`game "${found.plugin.manifest.gameName}"'s decide adapter is not installed on this node`);
      return { held, results: headToHeadResults(list, (moves, config) => box.call('decide', { moves, config }), found.config, { players: found.plugin.manifest.players }) };
    })();
    return entries.map(({ entryId, entry }) => decided.then(({ held, results }) => {
      const r = results[hex(entryId)];
      const rv = held.get(hex(entryId));
      this.queued.push({ entryId, objected: false });
      console.log(`[h2h] ${hex(roundIdBytes).slice(0, 16)} ${hex(entryId).slice(0, 16)}: ${rv ? `move ${rv.move}` : 'no reveal'} -> ${r.outcome} ${r.score}`);
      return this.#sign({ roundIdBytes, entryId, entry, contract,
        answer: { ok: true, outcome: r.outcome, score: r.score, coreHash: hex(contract.simCoreHash) },
        transcript: { roundId: entry.roundId, entryId, hash: transcriptBytesHash(this.#revealRecord(entryId, rv)) } });
    }).catch((e) => ({ entryId, stored: false, why: e.message })));
  }

  /**
   * WHAT A HEAD-TO-HEAD RESULT IS SIGNED OVER AND PUBLISHED AS: the entry's reveal record - entry id || move ||
   * salt, or entry id || 0xff for no reveal - in place of a run's transcript. Every seat builds it alike from the same
   * reveals, so its hash names it the way a transcript hash names a run, and publish() posts these bytes to the relays.
   */
  #revealRecord(entryIdBytes, reveal) {
    return reveal ? Uint8Array.of(...entryIdBytes, reveal.move, ...reveal.salt) : Uint8Array.of(...entryIdBytes, 0xff);
  }

  /**
   * EVERY PEER'S REVEALS FOR A HEAD-TO-HEAD ROUND, each taken only if it hashes to the commitment its entry
   * named and is a move the game offers. Not held to the reveal window: a peer's door already was, and a reveal that came
   * late can change no one's choice - the moves were committed before entry close. A peer that is down is skipped.
   */
  async carryReveals(roundIdBytes, entries, moveCount) {
    const byId = new Map(entries.map((e) => [hex(e.entryId), e.entry]));
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/reveals?round=${hex(roundIdBytes)}`);
        if (!answer.ok) continue;
        body = await answer.json();
      } catch { continue; }
      for (const r of (body && Array.isArray(body.reveals) ? body.reveals : [])) {
        const entry = byId.get(String(r.entry));
        if (!entry || !(entry.commit instanceof Uint8Array) || !Number.isInteger(r.move) || r.move < 0 || r.move >= moveCount) continue;
        const salt = /^[0-9a-f]{64}$/i.test(String(r.salt)) ? new Uint8Array(Buffer.from(r.salt, 'hex')) : null;
        if (!salt) continue;
        let c;
        try { c = headToHeadCommit({ roundId: entry.roundId, entryKey: entry.sessionPubkey, move: r.move, salt }); } catch { continue; }
        if (hex(c) !== hex(entry.commit)) continue;
        this.round.putReveal({ roundId: roundIdBytes, entryId: new Uint8Array(Buffer.from(r.entry, 'hex')), move: r.move, salt });
        // ITS IDENTITY TOO, kept only if its key signed it over this round and entry
        if (r.identity && /^[0-9a-f]{64}$/.test(String(r.identity.key)) && /^[0-9a-f]{128}$/.test(String(r.identity.sig)) && this.round.putIdentity) {
          const entryId = new Uint8Array(Buffer.from(r.entry, 'hex')), key = new Uint8Array(Buffer.from(r.identity.key, 'hex')), sig = new Uint8Array(Buffer.from(r.identity.sig, 'hex'));
          let good = false;
          try { good = schnorr.verify(sig, matchProofId({ roundId: roundIdBytes, entryId, identityKey: key }), key); } catch { good = false; }
          if (good) this.round.putIdentity({ roundId: roundIdBytes, entryId, identity: key, sig });
        }
      }
    }
  }

  #attested(contract) {
    const found = pluginForRound(contract, this.plugins);
    return found.ok && found.attested === true;
  }

  #coreOf(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(contract, this.plugins);
    // AND THE ROUND'S WORLD RULE: its config hash, census root and id, so the replay derives the world the page did
    return found.ok ? { ...found.core, config: found.config, runTicks: found.runTicks, items: itemUnlocksOf(found.plugin),
      world: { configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: new Uint8Array(roundIdBytes),
        sharedWorld: [...found.plugin.sharedWorld] } } : null;
  }

  /**
   * THE RESULT WINDOW IS THE OBJECTION WINDOW (2026-09-15 07:49): "same duration, on the
   * contract. A signer node that cannot retrieve the transcript in that window treats the entry as VOID."
   * A signer node still waiting on a signer node it cannot reach - so it cannot know the receipted transcript -
   * once its close plus the round's objection_window_ms has passed, decides by §13C's no-quorum
   * rule: VOID, or FORFEIT on the player's proven equivocation; a result already at the threshold
   * is not touched (the rule answers nothing for it). Decided once, kept with the other no-quorum
   * outcomes. Inside the window it answers null and the signer node waits, as before. This ends the
   * M3.3-34 hold "past the window, keep asking" for a signer node that cannot retrieve the transcript.
   */
  async #unretrievedPastWindow(roundIdBytes, entryId, contract, why) {
    // PAST THE RESULT WINDOW (§13A, WINDOW-10-SPEC): the round's end + 600 s, decided at + 605 s on this seat's clock.
    const rw = resultWindow(this.round, roundIdBytes, contract);
    if (!rw.ok) return null;
    const had = this.round.noQuorum(entryId);
    if (had) return { entryId, stored: false, decided: had.outcome, why: had.why };
    const line = this.round.startLine(roundIdBytes, entryId);
    if (!line) return null;
    const signers = new Set(this.round.results(roundIdBytes, entryId).map((r) => hex(r.nodePubkey))).size;
    // THE PROOF THIS SEAT HOLDS WHEN IT DECIDES, after asking the peers for theirs.
    const proven = await this.#equivocationProven(roundIdBytes, entryId, null, rw.window);
    const d = noQuorumRule({ signatures: signers, needed: line.needed,
      equivocationProven: proven,
      state: finalityOf(this.round, roundIdBytes, entryId).state });
    if (!d.outcome) return null;
    const reason = `${d.why} - this signer node could not retrieve the transcript within the result window, `
      + `closed at ${new Date(Number(rw.closesAtMs)).toISOString()}: ${why}`;
    this.round.putNoQuorum({ entryId, roundId: roundIdBytes, outcome: d.outcome, why: reason });
    return { entryId, stored: false, decided: d.outcome, why: reason };
  }

  /**
   * §13C FOR A RUN THIS SIGNER NODE SIGNED, PAST ITS RESULT WINDOW, THAT NO QUORUM CAN REACH ANY MORE (the
   * follow-up to 2026-09-15 07:49). Measured: a signer node back after its peer had decided VOID
   * signed 1 of 2 and its watch asked with no end. Not on the peer's word about the entry - only on
   * the count of signer nodes that say they decided it by §13C and so will sign nothing (`gather`'s
   * noQuorumPeers): when the signer nodes left cannot reach the threshold and this signer node's own result window
   * (its close + objection_window_ms) has passed, it decides by the same rule - VOID, or FORFEIT on
   * proven equivocation. A quorum that can still form, or has, is not touched.
   */
  async shortPastWindow(roundIdBytes, entryIdBytes, gathered) {
    const row = this.round.get(roundIdBytes);
    if (!row) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    // PAST THE RESULT WINDOW (§13A, WINDOW-10-SPEC): the round's end + 600 s, decided at + 605 s on this seat's clock.
    const rw = resultWindow(this.round, roundIdBytes, contract);
    if (!rw.ok) return null;
    const had = this.round.noQuorum(entryIdBytes);
    if (had) return { entryId: entryIdBytes, stored: false, decided: had.outcome, why: had.why };
    const line = this.round.startLine(roundIdBytes, entryIdBytes);
    if (!line || !gathered) return null;
    const signerNodes = this.round.signerNodes(roundIdBytes).length;
    const declined = new Set((gathered.noQuorumPeers || []).map((p) => p.peer)).size;
    if (signerNodes - declined >= line.needed) return null;          // a quorum can still form
    const signers = new Set(this.round.results(roundIdBytes, entryIdBytes).map((r) => hex(r.nodePubkey))).size;
    const d = noQuorumRule({ signatures: signers, needed: line.needed,
      equivocationProven: await this.#equivocationProven(roundIdBytes, entryIdBytes, null, rw.window),
      state: finalityOf(this.round, roundIdBytes, entryIdBytes).state });
    if (!d.outcome) return null;
    const why = `${d.why} - past the result window (closed ${new Date(Number(rw.closesAtMs)).toISOString()}) with ${signers} of ${line.needed} signatures, and `
      + `${declined} of ${signerNodes} signer nodes decided it by §13C, so no quorum can form`;
    this.round.putNoQuorum({ entryId: entryIdBytes, roundId: roundIdBytes, outcome: d.outcome, why });
    return { entryId: entryIdBytes, stored: false, decided: d.outcome, why };
  }

  /**
   * §13C'S NO-QUORUM RULE FOR A ONE-SIGNER NODE REFUSAL (M3.3-34, ruled). The evidence,
   * on this signer node's own record: it holds the player's on-time first mark with
   * fewer than the threshold's receipts, and the signer nodes it is short of answered
   * the forward and REFUSED it (they were up - not §16's outage); or it is the
   * signer node that refused (refused_first_marks) and holds no first mark. Only when
   * no signer node is unreachable (a signer node that cannot be reached may still carry the
   * mark: the hold goes on). Before the result window has passed - this signer node's
   * close plus the round's objection window - it holds; after it, VOID, or
   * FORFEIT when the player's equivocation is proven (§13B). Not ENTRY_VOID, not
   * a late start, never a FINAL result (§14). Answers null when this is not
   * that case.
   */
  async #noQuorum(roundIdBytes, entryId, contract, down) {
    const had = this.round.noQuorum(entryId);
    if (had) return { entryId, stored: false, decided: had.outcome, why: had.why };
    // THE RESULT WINDOW, AND THE EVIDENCE IN IT (RULED 2026-09-24): once its end block is here, every piece of evidence
    // - a late start, a pair, a refusal - counts only if it sits strictly before that block, at every holder. Before it,
    // nothing is decided, and what evidence there is only says the decision is pending.
    const rw = resultWindow(this.round, roundIdBytes, contract);
    // PAST THE WINDOW (wall clock): the evidence this seat held before its decision instant counts (WINDOW-10-SPEC).
    const win = rw.ok ? rw.window : null;
    if (win) await this.#pullEvidenceBlocks(roundIdBytes, entryId);
    const counts = (m) => !win || this.round.markCounts(entryId, m, win.chain, win.end);
    // AN OUTAGE-VOID, THEN THE PLAYER'S SECOND FIRST MARK (ruled 2026-09-12): the
    // Void stays as history and the entry is decided here like any two first
    // marks - FORFEIT after the window. A Void with no such proof is decided VOID past the end block: NO FREE STAND
    // (RULED 2026-09-24) - a late closer holding a peer's Void writes the §13C record every holder writes.
    const voided = !!this.round.entryVoid(entryId);
    // A signer node down stops the rule - unless this signer node holds the proof of two first
    // marks itself: that FORFEIT needs no quorum (§13B). Measured before: signer node B
    // down through the hold's expiry, A holding the proof decided nothing and
    // the hold stayed in flight to expire back to the player. Nor, past the end block, a Void: a pair only a down
    // signer node holds is the ruled residual, not a reason to write nothing.
    if (down && !this.round.provenTwoFirstMarks(roundIdBytes, entryId, win) && !(voided && win)) return null;
    const line = this.round.startLine(roundIdBytes, entryId);
    if (!line) return null;
    // A LATE START IS FORFEIT 0 AT THE CLOSE (a390ca0) - unless the player also
    // signed an on-time first mark somewhere: two first marks, one parent, the
    // player's equivocation (§13B). Then no quorum is reachable and the rule's
    // answer is FORFEIT, decided here after the window like every no-quorum
    // outcome - never ENTRY_VOID (measured before: ENTRY_VOID and the lock
    // forfeited to the player at both signer nodes). A late start at or after the end block is outside.
    const late = this.round.startForfeit(entryId);
    const lateHere = !!late && counts(late.mark);
    // ...or a proof this signer node holds itself (it refused a second first mark) - or
    // a first mark this signer node holds that no quorum carried: the other signer nodes may
    // hold the player's other first mark, and the proof is portable, so it is
    // asked of them. Measured before on 5 of 7: signer nodes that took the second first
    // mark by forward never saw the first, asked nobody, and decided nothing.
    const suspect = lateHere || voided || this.round.equivocation(roundIdBytes, entryId).length > 0
      || !!this.round.firstMarkHeld(roundIdBytes, entryId);
    const twoFirst = suspect ? await this.#equivocationProven(roundIdBytes, entryId, null, win) : false;
    if (lateHere && !twoFirst) return null;
    if (voided && !twoFirst && !win) return null;
    const held = this.round.firstMarkHeld(roundIdBytes, entryId);
    // A PEER'S ENTRY_VOID, PAST THE END BLOCK (RULED 2026-09-24): a holder with no first mark of its own reads the Void a peer
    // holds - its on-time first mark placed at the block that peer named - as the same evidence, and writes the same VOID.
    // Not recorded here as an ENTRY_VOID: only the §13C record every holder writes.
    const peerVoid = win && !voided && !twoFirst && !held ? await this.#peerVoidBefore(roundIdBytes, entryId, counts) : null;
    let evidence;
    if (twoFirst) {
      evidence = 'the player signed two first marks for this entry - one of them late (§13B)';
    } else if (voided) {
      evidence = 'this signer node holds the entry ENTRY_VOID and no pair of first marks sits before the result window\'s end block';
    } else if (peerVoid) {
      evidence = `signer node ${peerVoid} holds the entry ENTRY_VOID on a first mark before the result window's end block, and no pair of first marks sits before it`;
    } else if (held) {
      let c;
      try { c = decodeMark(splitMark(held).body); } catch { return null; }
      if (c.tick > line.lastTick || !c.previousHash.every((x) => x === 0)) return null;
      const receipts = this.round.receiptCount(markIdOf(c));
      if (receipts >= line.needed) return null;
      // A REFUSAL COUNTS WHERE THIS NODE RECORDED IT (RULED 2026-09-24): strictly before the end block.
      const offers = this.round.firstMarkOfferBlocks(entryId);
      const refused = Object.values(offers).filter((o) => o.answer === 'refused'
        && (!win || (o.atMs !== null && o.atMs !== undefined && BigInt(o.atMs) < BigInt(win.end.untilMs)))).length;
      if (refused < line.needed - receipts) return null;
      evidence = `the on-time first mark here has ${receipts} of ${line.needed} receipts and ${refused} signer node(s) that were up refused it`;
    } else {
      // THIS SIGNER NODE REFUSED IT, or ANOTHER SIGNER NODE SHOWS IT REFUSED IT (checked in
      // this close's pull): the first mark reached only a signer node that refused it,
      // and no signer node holds it. Measured before: FORFEIT 0 at both signer nodes. Each refusal counts where its
      // refusing node recorded it (RULED 2026-09-24).
      const own = this.round.refusedFirstMark(entryId);
      const r = own && counts(own.mark) ? own : null;
      const carried = this.carried.get(`${hex(roundIdBytes)}:${hex(entryId)}`);
      const shownAll = carried && carried.refusedMarks && carried.refusedMarks.length ? carried.refusedMarks : [];
      const shownCounted = shownAll.filter((x) => !x.markId || counts(x.markId));
      const shown = shownCounted.length ? shownCounted : null;
      if (!r && !shown) return null;
      evidence = r
        ? `this signer node was up, refused the player's on-time first mark (${String(r.why).slice(0, 90)}) and holds none`
        : `${shown.length} signer node(s) that were up refused the player's on-time first mark (${shown[0].why.slice(0, 80)}), and no signer node holds it`;
    }
    // ONLY ONCE THE RESULT WINDOW HAS ENDED ON THE CHAIN (RULED 2026-09-24): its end block, the same for every holder.
    if (!rw.ok)
      return { entryId, stored: false, waiting: true, noQuorumPending: true,
        why: `no quorum yet: ${evidence} - decided only once the result window ends on the chain: ${rw.why}` };
    const signers = new Set(this.round.results(roundIdBytes, entryId).map((r) => hex(r.nodePubkey))).size;
    const d = noQuorumRule({ signatures: signers, needed: line.needed,
      equivocationProven: twoFirst || await this.#equivocationProven(roundIdBytes, entryId, null, win),
      state: finalityOf(this.round, roundIdBytes, entryId).state });
    if (!d.outcome) return null;
    this.round.putNoQuorum({ entryId, roundId: roundIdBytes, outcome: d.outcome, why: `${d.why} - ${evidence}` });
    return { entryId, stored: false, decided: d.outcome, why: d.why };
  }

  /**
   * EVERY PEER'S EVIDENCE RECORDS FOR AN ENTRY'S MARKS AND THE BLOCKS THEY NAME (§13C, RULED 2026-09-24): kept here as
   * the peer named them (`/evidence-blocks`), so a mark is placed at the earliest block among the records this node holds.
   * A peer that cannot answer shows nothing - an earlier record it alone holds is the ruled residual.
   */
  async #pullEvidenceBlocks(roundIdBytes, entryId) {
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const r = await fetch(`${peer}/evidence-blocks?entry=${hex(entryId)}`);
        if (r.status !== 200) continue;
        const got = await r.json();
        for (const x of (got && got.marks) || []) {
          if (!/^[0-9a-f]{64}$/.test(String(x.mark)) || !/^[0-9a-f]{64}$/.test(String(x.block))) continue;
          this.round.noteEvidenceBlock(roundIdBytes, entryId, Uint8Array.from(Buffer.from(x.mark, 'hex')), Uint8Array.from(Buffer.from(x.block, 'hex')),
            Number.isSafeInteger(x.seenMs) ? x.seenMs : undefined);
        }
      } catch { /* a signer node that cannot answer shows nothing */ }
    }
  }

  /** A peer that holds the entry ENTRY_VOID on an on-time first mark of it that counts in the window (`counts`), or null. */
  async #peerVoidBefore(roundIdBytes, entryId, counts) {
    for (const peer of this.peersOf(roundIdBytes)) {
      try {
        const r = await fetch(`${peer}/entry-void?entry=${hex(entryId)}`);
        if (r.status !== 200) continue;
        const got = await r.json();
        const mark = Uint8Array.from(Buffer.from(String(got.firstMark || ''), 'hex'));
        const c = this.round.onTimeFirstMark(mark);
        if (c && hex(c.entryId) === hex(entryId) && counts(mark)) return peer;
      } catch { /* a signer node that cannot answer shows nothing */ }
    }
    return null;
  }

  /**
   * BEFORE A §13C OUTCOME IS READ FROM THE RE-RUN WINDOW (RULED 2026-09-24): the peers' evidence records and their pairs,
   * kept here, so the window's proof is read off the same records a holder that asked would hold.
   */
  async pullEvidence(roundIdBytes, entryIdBytes) {
    await this.#pullEvidenceBlocks(roundIdBytes, entryIdBytes);
    await this.#equivocationProven(roundIdBytes, entryIdBytes);
  }

  /**
   * IS THE PLAYER'S EQUIVOCATION PROVEN (§13B)? A pair of the entry's own signed
   * marks that `provesEquivocation` accepts - from this signer node's store, or from
   * any signer node's /equivocation door, each pair checked here and never taken on
   * a peer's word.
   */
  /** Pull the other signer nodes' proof of two first marks and keep it here if it verifies (M3.3-34). */
  async pullFirstMarkProof(roundIdBytes, entryId) {
    return this.#equivocationProven(roundIdBytes, entryId);
  }

  /**
   * THE SAME PULL, AND WHETHER IT REACHED EVERY OTHER SIGNER NODE (M3.3-34, ruled
   * 2026-09-13): `{ proven, peers, reached }` - a signer node reached is one that
   * answered its /equivocation ask at all. What a signer node that learned the Void only
   * from a forfeit ask needs before it signs a lock refund: with a signer node
   * unreachable, that signer node may hold the proof ("a signer node down stops the rule").
   */
  async pullFirstMarkProofReach(roundIdBytes, entryId) {
    const report = { peers: 0, reached: 0 };
    const proven = await this.#equivocationProven(roundIdBytes, entryId, report);
    return { proven, peers: report.peers, reached: report.reached };
  }

  async #equivocationProven(roundIdBytes, entryId, report = null, window = null) {
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryId));
    if (!found) return false;
    // IN A WINDOW (RULED 2026-09-24): the peers' own records of the marks and the blocks they name come first, so each mark
    // is placed at the earliest block this node then holds; a pair counts only if both its marks sit before the end block.
    if (window) await this.#pullEvidenceBlocks(roundIdBytes, entryId);
    const counts = (m) => !window || this.round.markCounts(entryId, m, window.chain, window.end);
    const verify = (sig, msg, pub) => { try { return sessionCurve.verify(sig, msg, pub); } catch { return false; } };
    const pairs = this.round.equivocation(roundIdBytes, entryId).map((f) => [f.stored, f.offered]);
    // The on-time first mark this signer node voided and the late one it kept: one parent, two chains.
    const voided = this.round.entryVoid(entryId);
    const late = this.round.startForfeit(entryId);
    if (voided && late) pairs.push([voided.firstMark, late.mark]);
    // THE PLAYER'S OTHER FIRST MARK, PULLED (M3.3-34, path 2): a peer's late first
    // mark, or the first mark a peer voided - paired with this signer node's own first
    // mark, so a lost forward still leaves the pair to be pulled at the close.
    const mine = [voided && voided.firstMark, late && late.mark, this.round.firstMarkHeld(roundIdBytes, entryId)].filter(Boolean);
    if (mine.length) {
      for (const peer of this.peersOf(roundIdBytes)) {
        try {
          const r = await fetch(`${peer}/late-first-mark?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`, { signal: AbortSignal.timeout(PEER_WAIT_MS) });
          if (r.status === 200) { const theirs = new Uint8Array(await r.arrayBuffer()); for (const m of mine) pairs.push([m, theirs]); }
        } catch { /* a signer node that cannot answer proves nothing */ }
        try {
          const r = await fetch(`${peer}/entry-void?entry=${hex(entryId)}`, { signal: AbortSignal.timeout(PEER_WAIT_MS) });
          if (r.status === 200) {
            const got = await r.json();
            if (got.firstMark) { const theirs = Uint8Array.from(Buffer.from(String(got.firstMark), 'hex')); for (const m of mine) pairs.push([m, theirs]); }
          }
        } catch { /* a signer node that cannot answer proves nothing */ }
      }
    }
    for (const peer of this.peersOf(roundIdBytes)) {
      if (report) report.peers++;
      try {
        const r = await fetch(`${peer}/equivocation?round=${hex(roundIdBytes)}&entry=${hex(entryId)}`, { signal: AbortSignal.timeout(PEER_WAIT_MS) });
        if (report) report.reached++;
        if (r.status !== 200) continue;
        const body = new Uint8Array(await r.arrayBuffer());
        for (let at = 0; at + 2 * SIGNED_MARK_BYTES <= body.length; at += 2 * SIGNED_MARK_BYTES)
          pairs.push([body.slice(at, at + SIGNED_MARK_BYTES), body.slice(at + SIGNED_MARK_BYTES, at + 2 * SIGNED_MARK_BYTES)]);
      } catch { /* a signer node that cannot answer proves nothing */ }
    }
    // EACH PAIR ONCE, AND A KEPT PAIR NOT CHECKED AGAIN (measured live 2026-10-06 on 0.0.2815, entry 0b68a08f): a
    // page stuck on an old head sent 63 refused marks; every peer served the same 63 pairs, each was verified again on every
    // call, and provenFork - itself over every pair - ran once per pair. A seat's one thread sat at 100% for minutes and
    // five seats never signed the entry. Now: duplicates dropped, a pair this node already keeps (verified when it was
    // stored) is not verified again, and the later-parent limb's provenFork is asked once, after the pairs are kept.
    const seen = new Set();
    let laterParent = false;
    for (const [a, b] of pairs) {
      try {
        const key = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? hex(a) + hex(b) : hex(b) + hex(a);
        if (seen.has(key)) continue;
        seen.add(key);
        const kept = this.round.pairKept(entryId, a, b);
        if (kept || (await provesEquivocation(a, b, found.entry.sessionPubkey, verify)).ok) {
          // A PULLED PAIR OF FIRST MARKS IS KEPT HERE TOO, so this signer node's own
          // record (its forfeit door, its close) says two first marks from now on.
          // AND A FORK AT ANY LATER TICK, kept as a pair (§13B): this node's close and its /equivocation
          // say it from now on, as the seat that held it does
          if (!kept && !this.round.putFirstMarkPair({ a, b })) this.round.putForkPair({ a, b });
          // WHAT A PAIR PROVES (RULED 2026-10-05 (b)): two first marks, or two marks at one tick - as ever; two chains
          // from one later parent only when both marks were receipted by a seat (the store's own ruled check, provenFork) -
          // a page stuck on an old head sends refused marks naming that head, and those forfeit nothing
          const ca = decodeCheckpoint(splitSignedMark(a).body), cb = decodeCheckpoint(splitSignedMark(b).body);
          const zero = (h) => h.every((v) => v === 0);
          const firstPair = zero(ca.previousHash) && zero(cb.previousHash);
          if (!(counts(a) && counts(b))) continue;
          if (firstPair || ca.tick === cb.tick) return true;
          laterParent = true;
        }
      } catch { /* not a proof */ }
    }
    return laterParent && this.round.provenFork(roundIdBytes, entryId, window) !== null;
  }

  /**
   * THE REPLAY AT THE LAST RECEIPTED CHECKPOINT of a run the close found LIVE:
   * where §15 says the valid run ends. Ticks this signer node stored past that mark
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
      liquidations: full.liquidations.filter((l) => l[0] < last), loads: full.loads.filter((l) => l[0] < last),
      samples: (full.samples || []).filter((l) => l[0] < last), tapes: (full.tapes || []).filter((l) => l[0] < last) };
    return this.pool.submit({ core: this.#coreOf(roundIdBytes), key: `${hex(roundIdBytes)}:${hex(entryId)}:stopped`, objected: false,
      transcript: prefix, entry, options });
  }

  #sign({ roundIdBytes, entryId, entry, contract, answer, transcript, stopped = false }) {
    // A ROUND PLAYED AGAINST THE PRICE FEED (§11) signs the front its run ended on (§13 front_*)
    let priceRound = false;
    try { priceRound = !!(this.round.pricesRequired && this.round.pricesRequired(encodeRoundContract(contract))); } catch { priceRound = false; }
    const built = resultFrom({
      answer, contract, entry, transcript, entryId,
      nodePubkey: this.round.pubkey, stopped, priceRound,
    });
    if (!built.ok) return { entryId, stored: false, why: built.why };
    // NO PLAYER-NODE CONFLICT GATE (§5A.13, RULED 2026-10-14): a player declares no operator, so no signer node
    // withholds its result for one
    // THE TEST FAULT, FIRST RESULT (test-dissent.js dissentsFirstOn, off by default): one score higher
    if (dissentsFirstOn(entryId)) {
      built.result = { ...built.result, score: (built.result.score + 1) >>> 0 };
      built.encoded = encodePlayerResult(built.result);
      console.log(`[test-dissent] ${hex(entryId).slice(0, 16)}: first result signed with score ${built.result.score}, not ${built.result.score - 1}`);
    }

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
   * signer nodes about the ones that produced a signature.
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
      .then(async (replayed) => timed(`close asked the others ${hex(roundIdBytes).slice(0, 8)}`, async () => ({
        replayed,
        gathered: await Promise.all(replayed
          .filter((d) => d && d.stored)
          .map((d) => this.gather(roundIdBytes, d.entryId))),
      }), { over: 20 }));
    return this.settling;
  }

  /**
   * WHAT A WORKER IS GIVEN OF A RUN: its name when this store is a file, its rows when it is not (a test's memory).
   * The daemon's own thread reads no stored run it does not have to - it is the thread that pushes another player's
   * truck (2026-09-17 19:15, the ghost lag).
   */
  #runFor(roundIdBytes, entryIdBytes) {
    const store = this.round.db.blwpPath || null;
    return store
      ? { transcript: null, source: { store, roundId: roundIdBytes, entryId: entryIdBytes } }
      : { transcript: this.round.transcript(roundIdBytes, entryIdBytes), source: null };
  }

  /**
   * THE CLOSE, ONCE MORE, FOR A RUN THIS SIGNER NODE COULD NOT SIGN AT ITS CLOSE
   * (M3.3-34, the Daily's close). A signer node whose peer was down or unreachable at
   * the close could not pull that peer's receipts, so it could neither form the
   * receipted transcript of a run that played nor tell that no signer node held a
   * walk-away's first mark - it signed nothing, and nothing asked again.
   * Measured: both runs silent at the live signer node. The finality watch calls this
   * on its cadence: the cheap pull first, and only once every peer answered,
   * the same replay and signature the close makes. Until then it is waiting -
   * inside the result window; past it, a signer node still unable to retrieve the
   * transcript decides by §13C (2026-09-15 07:49, #unretrievedPastWindow).
   */
  retryClose(roundIdBytes, entryIdBytes) {
    return timed(`close retry ${hex(entryIdBytes).slice(0, 8)}`, () => this.#retryClose(roundIdBytes, entryIdBytes), { over: 50 });
  }

  async #retryClose(roundIdBytes, entryIdBytes) {
    { const row = this.round.get(roundIdBytes);
      if (row && this.#attested(decodeRoundContract(new Uint8Array(row.contract)))) return { entryId: entryIdBytes, stored: false, why: ATTESTED_NO_RUN }; }
    // A RUN THIS SIGNER NODE HAS SIGNED IS NOT CLOSED AGAIN (as `retry`): one signer node, one result.
    if (this.round.hasResult(roundIdBytes, entryIdBytes, this.round.pubkey))
      return { entryId: entryIdBytes, stored: false, why: 'this signer node has already signed this run' };
    const row = this.round.get(roundIdBytes);
    if (!row) return { entryId: entryIdBytes, stored: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return { entryId: entryIdBytes, stored: false, why: 'no such entry in that round' };
    const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry, entryIdBytes, this.chainFor);
    if (!beacon.ok) return { entryId: entryIdBytes, stored: false, why: beacon.why };
    const carried = await this.carryReceipts(roundIdBytes, entryIdBytes);
    // THE CHEAP ANSWER FIRST: still waiting on a signer node that matters, no replay.
    const noMarkHere = !this.round.firstMarkHeld(roundIdBytes, entryIdBytes);
    const down = this.#unreached(roundIdBytes, carried);
    // ...and not for an entry this signer node holds the proof of two first marks for
    // (§13B; M3.3-34): measured, this wait kept signer node A from deciding FORFEIT
    // with B down through the hold's expiry, after #keep no longer waited.
    if (down && !this.round.provenTwoFirstMarks(roundIdBytes, entryIdBytes)
      && (noMarkHere || this.#mightGrow(roundIdBytes, entryIdBytes, down))) {
      const why = `waiting on ${down} signer node(s): ${(carried.down.length ? carried.down.join('; ') : 'none of them answered').slice(0, 160)}`;
      // PAST THE RESULT WINDOW, still unable to retrieve the transcript: §13C decides (07:49).
      return (await this.#unretrievedPastWindow(roundIdBytes, entryIdBytes, contract, why))
        || { entryId: entryIdBytes, stored: false, waiting: true, why };
    }
    // A RUN WHOSE TRANSCRIPT CANNOT BE FRAMED: a batch longer than a transcript's u16 frame, taken before the
    // intake refused one - every replay of it fails the same way, so it is not replayed again (measured: all seven seats
    // retried a full replay back to back, then every 60 s without end); past the result window §13C decides it
    const largest = typeof this.round.largestBatch === 'function' ? this.round.largestBatch(roundIdBytes, entryIdBytes) : 0;
    if (largest > TRANSCRIPT_BATCH_MAX_BYTES) {
      const why = `a batch of this run is ${largest} bytes and a transcript frames each in at most ${TRANSCRIPT_BATCH_MAX_BYTES}: it can never be replayed or signed`;
      return (await this.#unretrievedPastWindow(roundIdBytes, entryIdBytes, contract, why)) || { entryId: entryIdBytes, stored: false, why };
    }
    const options = { roundRandomness: beacon.hash };
    const answer = await this.pool.submit({ core: this.#coreOf(roundIdBytes), key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:retry:${++retryJobs}`,
      objected: this.round.objected(roundIdBytes, entryIdBytes),
      ...this.#runFor(roundIdBytes, entryIdBytes), entry: found.entry, options });
    return this.#keep({ roundIdBytes, entryId: entryIdBytes, entry: found.entry, contract, answer, options });
  }

  /**
   * ASK THE OTHER SIGNER NODES WHAT THEY FOUND, AND COUNT.
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
   * signer node by answering.
   */
  gather(roundIdBytes, entryIdBytes) {
    return timed(`close gather ${hex(entryIdBytes).slice(0, 8)}`, () => this.#gather(roundIdBytes, entryIdBytes), { over: 50 });
  }

  async #gather(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (row && this.#attested(decodeRoundContract(new Uint8Array(row.contract)))) return { entryId: entryIdBytes, stored: false, why: ATTESTED_NO_RUN };
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    // WHOSE RUN THIS IS, off the entry the node itself stores.
    const mine = this.round.entriesOf(roundIdBytes)
      .find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!mine) return { ok: false, why: 'no such entry in that round' };
    const playerPubkey = mine.entry.playerPubkey;

    let fetched = 0, kept = 0, refused = 0;
    // AND EACH SIGNER NODE'S OWN WORD THAT IT DECIDED THE ENTRY BY §13C (x-no-quorum): not taken as the entry's
    // outcome here - it only says that signer node will sign nothing, which `shortPastWindow` counts.
    const noQuorumPeers = [];
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const url = `${peer}/results?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`;
        // A PEER THAT IS SLOW IS A PEER THAT IS DOWN, AFTER THIS LONG. The call had no deadline at all, and a close
        // gather waits on it before it may move to the next entry - measured on the Daily, gathers running 2946 to
        // 6140 ms each while a page's own calls were aborting at 8 s. "A peer that is down is not a fault" was
        // already this function's rule; without a deadline it was a rule it could not keep.
        const answer = await fetch(url, { signal: AbortSignal.timeout(PEER_WAIT_MS) });
        if (!answer.ok) { refused++; continue; }
        const said = answer.headers.get('x-no-quorum');
        if (said) noQuorumPeers.push({ peer, outcome: said });
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { refused++; continue; }      // a peer that is down is not a fault

      // THE RECORDS A PEER SENT, CHECKED: every one split, decoded, re-encoded to its own id and checked against the
      // signature under the key it names. This is the continuation after that peer answered, and it is timed because a
      // stall named only "a promise" is a stall nobody can act on (2026-09-17 19:15).
      timed(`close gather records ${hex(entryIdBytes).slice(0, 8)}`, () => {
        // record by record, each its type's size
        for (const record of cutSignedResults(body)) {
          fetched++;
          if (this.#keepPeerResult(roundIdBytes, entryIdBytes, record, playerPubkey)) kept++;
        }
      }, { over: 20 });
    }

    const { held, seen } = timed(`close gather counted ${hex(entryIdBytes).slice(0, 8)}`, () => {
      const rows = this.round.results(roundIdBytes, entryIdBytes);
      return { held: rows, seen: verifiedFinal(rows.map((r) => r.bytes), {
        contract, signerNodes: this.round.signerNodes(roundIdBytes),
      }) };
    }, { over: 20 });
    // The entry is in the answer because a caller with a round's worth of
    // them cannot otherwise say which run each one is about.
    return { ok: true, entryId: entryIdBytes, fetched, kept, refused, held: held.length, noQuorumPeers, ...seen };
  }

  /**
   * POST THE AGREED RUN'S TRANSCRIPT WHERE ANYONE CAN REPLAY IT, AND SAY SO (P2).
   *
   * v4.6.2 §13A: a result is not FINAL until the canonical transcript it names
   * has been retrieved by the round's threshold of settlement signer nodes and posted
   * by them to the contract's `publication_relays[]`. Measured before this: a
   * seven-signer node run and a two-daemon round went FINAL and moved money with the
   * contract's relay asked nothing (publication-finality.test.js).
   *
   * This signer node, if it is one: take the transcript the agreed result names - its
   * own canonical one, else a peer's `/canonical`, either way only if its bytes
   * hash to that name - PUT it to every relay, read it back, and only when at
   * least one relay gives back the same bytes sign a posting. Then take every
   * peer's postings, each checked as far as it can be. Idempotent: a signer node that
   * has posted does not post again, and the gather is the same gather.
   */
  async publish(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const signerNodes = this.round.signerNodes(roundIdBytes);
    const mine = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!mine) return { ok: false, why: 'no such entry in that round' };
    const playerPubkey = mine.entry.playerPubkey;

    // WHICH TRANSCRIPT: the one the agreed run names, and no other.
    const held = this.round.results(roundIdBytes, entryIdBytes);
    const seen = verifiedFinal(held.map((r) => r.bytes), { contract, signerNodes });
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
    const joined = signerNodes.some((s) => hex(s) === hex(this.round.pubkey));
    const said = this.round.postings(roundIdBytes, entryIdBytes).some((p) => hex(p.signerNodePubkey) === hex(this.round.pubkey));
    const relays = contract.publicationRelays || [];
    if (joined && !said && !relays.length)
      report.refused.push('the round contract names no publication relay, so this signer node can post its transcript nowhere');
    // THE TEST FAULT, LATE POSTING (test-dissent.js postsLateOn, off by default): for its one named entry this
    // seat posts nothing until its own clock reads the round's final_after + 10 s
    let holdLate = false;
    if (joined && !said && postsLateOn(entryIdBytes)) {
      let w = null; try { w = windowsOf(contract); } catch { w = null; }
      if (w && BigInt(this.round.now()) < w.finalAfterMs + LATE_POSTING_AFTER_MS) {
        holdLate = true;
        if (!this.latePostingSaid.has(hex(entryIdBytes))) {
          this.latePostingSaid.add(hex(entryIdBytes));
          const at = Number(w.finalAfterMs + LATE_POSTING_AFTER_MS);
          console.log(`[test-late-posting] ${hex(entryIdBytes).slice(0, 16)}: no posting until ${new Date(at).toISOString()}`);
          // AND THEN IT POSTS, whether or not anything still asks it to: an entry decided at the deadline is never published
          // again by the close, so the fault makes the late posting itself (measured live 2026-10-04: without this, the
          // late posting never existed). On this seat's own clock.
          const rid = new Uint8Array(roundIdBytes), eid = new Uint8Array(entryIdBytes);
          setTimeout(() => {
            this.publish(rid, eid).then((r) => console.log(`[test-late-posting] ${hex(eid).slice(0, 16)}: posted late - ${r && r.ok ? 'published' : (r && r.why) || 'done'}`),
              (e) => console.log(`[test-late-posting] ${hex(eid).slice(0, 16)}: the late posting failed: ${e.message}`));
          }, Math.max(0, at - Number(this.round.now())) + 500).unref?.();
        }
      }
    }
    if (joined && !said && relays.length && !holdLate) {
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
      // THE POSTING NAMES THE BLOCK IT SITS IN (§13A, RULED 2026-09-24): this node's chain tip when it posts.
      const tip = chainIndex(this.round, roundIdBytes, contract);
      if (readBack && !tip.ok) report.refused.push(`this signer node names no block for its posting: ${tip.why}`);
      if (readBack && tip.ok) {
        const posting = { roundId: roundIdBytes, playerPubkey, transcriptHash, signerNodePubkey: this.round.pubkey, blockHash: tip.tipHash() };
        const body = encodeTranscriptPosting(posting);
        const signature = schnorr.sign(transcriptPostingId(posting), this.round.identity.secret);
        this.round.putPosting(roundIdBytes, entryIdBytes, this.round.pubkey, joinSignedPosting(body, signature));
      }
    }

    // AND THE OTHER SIGNER NODES' WORD, each checked here, never taken on arrival.
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/postings?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) continue;
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { continue; }                  // a peer that is down is not a fault
      for (let at = 0; at + SIGNED_POSTING_BYTES <= body.length; at += SIGNED_POSTING_BYTES)
        this.#keepPeerPosting(roundIdBytes, entryIdBytes, body.slice(at, at + SIGNED_POSTING_BYTES), playerPubkey, signerNodes);
    }

    const count = transcriptIsPublished({
      roundId: roundIdBytes, playerPubkey, transcriptHash, postings: this.round.postings(roundIdBytes, entryIdBytes),
      signerNodes, settlementSlots: contract.settlementSlots, verify: (s, m, k) => schnorr.verify(s, m, k),
    });
    return { ...count, entryId: entryIdBytes, ...report };
  }

  /**
   * AN OBJECTION BUNDLE AT THIS SEAT'S DOOR (§13ARULED 2026-10-04): checked here, on its own
   * evidence, before anything is stored - the objector's signature, what it names, the transcript's hash and chain, that
   * it is this entry's, a committee member's receipt on every checkpoint, and a replay under the round's own core through
   * the same pool as a close (first in its queue: it is objected). `signedResultId` is the run it is filed against.
   */
  async checkObjection(roundIdBytes, entryIdBytes, bundle, signedResultId) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { holds: false, step: 'names', why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return { holds: false, step: 'names', why: 'no such entry in that round' };
    const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry, entryIdBytes, this.chainFor);
    if (!beacon.ok) return { holds: false, step: 'replay', why: `no beacon to replay under: ${beacon.why}` };
    const core = this.#coreOf(roundIdBytes);
    if (!core) return { holds: false, step: 'replay', why: 'this signer node holds no core for that round' };
    // THE DOOR IS OPEN TO ANYONE, SO ITS REPLAYS ARE BOUNDED (audit: every bundle that passed the cheap checks cost a
    // full replay, ~1.4 s measured live, first in the pool - a flood of copies would have starved the closes):
    //   - ONE CHECK IN FLIGHT PER ENTRY: the next bundle for that entry waits its turn (its arrival is already stamped at
    //     the door, so waiting never makes an objection late);
    //   - THE SAME RUN IS REPLAYED ONCE: a replay is keyed by the bytes it replays (transcript and inputs) and the length
    //     replayed, kept in flight and after, so copies of one bundle share one answer;
    //   - AND IN THE ORDINARY CLASS: a check is not yet an objection, so it does not go ahead of a close. The re-run a held
    //     objection starts is still first (rerun, objected: true).
    const tail = this.objectionTurns.get(hex(entryIdBytes)) || Promise.resolve();
    let release;
    const turn = new Promise((r) => { release = r; });
    const mine = tail.then(() => turn);
    this.objectionTurns.set(hex(entryIdBytes), mine);
    await tail;
    try {
      let content = '';
      try { const p = decodeObjectionBundle(bundle); content = hex(sha256(new Uint8Array([...p.transcript, ...(p.inputs || [])]))); } catch { content = ''; }
      return await checkObjectionBundle({
        bundle, roundId: roundIdBytes, entryId: entryIdBytes, entry: found.entry, contract,
        committee: this.round.signerNodes(roundIdBytes), signedResultId, core, roundRandomness: beacon.hash,
        verify: (sig, msg, key) => verifyKept(sig, msg, key),
        replayRun: (form, entry, options) => {
          const key = `${hex(roundIdBytes)}:${hex(entryIdBytes)}:${content}:${form.ticks.length}`;
          const had = content && this.objectionReplays.get(key);
          if (had) return had;
          this.objectionReplayCount++;
          const job = this.pool.submit({ core, key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:objection:${++objectionJobs}`,
            objected: false, transcript: form, source: null, entry, options: { roundRandomness: options.roundRandomness, marks: options.marks || [] } });
          if (content) {
            this.objectionReplays.set(key, job);
            job.catch(() => this.objectionReplays.delete(key));
            if (this.objectionReplays.size > 256) this.objectionReplays.delete(this.objectionReplays.keys().next().value);
          }
          return job;
        },
      });
    } finally {
      release();
      if (this.objectionTurns.get(hex(entryIdBytes)) === mine) this.objectionTurns.delete(hex(entryIdBytes));
    }
  }

  /**
   * RE-RUN A SUSPENDED RESULT, AND COUNT THE COMMITTEE'S RE-RUNS (v4.6.2 §13A).
   *
   * "The full committee re-runs the canonical transcript; the replay outcome is
   * authoritative." Measured before this: a result five of seven signed and a
   * valid objection contradicted stayed SUSPENDED two windows later, nothing
   * released and nothing re-run (rerun.test.js, 2f01ea1).
   *
   * This signer node, if it is one and has not re-run this run yet: replays the run
   * again through the same pool as the close - a new job, not its old answer -
   * and signs the result the CURRENT canonical transcript gives, tied to the
   * contradicted run. Then takes every peer's re-runs, each checked. Returns the
   * count; whether it replaces SUSPENDED is `resultFinality`'s to say.
   */
  async rerun(roundIdBytes, entryIdBytes, contradictedRunId) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const signerNodes = this.round.signerNodes(roundIdBytes);
    const found = this.round.entriesOf(roundIdBytes).find((e) => hex(e.entryId) === hex(entryIdBytes));
    if (!found) return { ok: false, why: 'no such entry in that round' };
    const report = { refused: [] };

    const joined = signerNodes.some((s) => hex(s) === hex(this.round.pubkey));
    const done = this.round.reruns(roundIdBytes, entryIdBytes).some((r) => hex(r.signerNodePubkey) === hex(this.round.pubkey));
    if (joined && !done) {
      const beacon = beaconFor(this.randomnessFor, contract, roundIdBytes, found.entry, entryIdBytes, this.chainFor);
      if (!beacon.ok) report.refused.push(beacon.why);
      else {
        const answer = await this.pool.submit({ core: this.#coreOf(roundIdBytes),
          key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:rerun`,
          objected: true,
          ...this.#runFor(roundIdBytes, entryIdBytes),
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
        let scored = canonical && answer.outcome === null
          ? await this.#atLastMark(roundIdBytes, entryIdBytes, found.entry, answer, canonical, { roundRandomness: beacon.hash })
          : answer;
        // §13B AT ANY TICK HOLDS IN A RE-RUN TOO (audit): an entry this seat holds a proven fork of is re-run as
        // FORFEIT, score 0 - never the replayed run, or an objection against its FORFEIT would hand the equivocator its run back
        if (canonical) {
          if (!this.round.provenFork(roundIdBytes, entryIdBytes)) await this.#equivocationProven(roundIdBytes, entryIdBytes);
          const fork = this.round.provenFork(roundIdBytes, entryIdBytes);
          if (fork) scored = { ok: true, outcome: 'FORFEIT', score: 0, coreHash: this.#coreOf(roundIdBytes)?.hash };
        }
        const built = canonical && resultFrom({
          answer: scored, contract, entry: found.entry, transcript: canonical, entryId: entryIdBytes,
          nodePubkey: this.round.pubkey, stopped: true,
        });
        if (built && !built.ok) report.refused.push(built.why);
        // THE RE-RUN CARRIES WHEN IT WAS SIGNED, ON THIS SEAT'S CLOCK (§13A, WINDOW-10-SPEC, RULED 2026-10-01): a holder
        // counts it only within 5 s of its own clock at arrival, before its re-run window's end + 5 s.
        if (built && built.ok) {
          // THE TEST FAULT (test-dissent.js, off by default): for its one named entry this seat signs a different run.
          const result = dissentsOn(entryIdBytes) ? { ...built.result, score: (built.result.score + 1) >>> 0 } : built.result;
          if (dissentsOn(entryIdBytes)) console.log(`[test-dissent] ${hex(entryIdBytes).slice(0, 16)}: re-run signed with score ${result.score}, not ${built.result.score}`);
          const x = { contradictedRunId, signedAtMs: BigInt(this.round.now()), result };
          const signature = schnorr.sign(rerunResultId(x), this.round.identity.secret);
          this.round.putRerun(roundIdBytes, entryIdBytes, this.round.pubkey, joinSignedRerun(encodeRerunResult(x), signature));
        }
      }
    }

    // AND THE OTHER SIGNER NODES' RE-RUNS, each checked here, never taken on arrival.
    for (const peer of this.peersOf(roundIdBytes)) {
      let body;
      try {
        const answer = await fetch(`${peer}/reruns?round=${hex(roundIdBytes)}&entry=${hex(entryIdBytes)}`);
        if (!answer.ok) continue;
        body = new Uint8Array(await answer.arrayBuffer());
      } catch { continue; }
      for (const rec of cutSignedReruns(body))
        this.#keepPeerRerun(roundIdBytes, rec.slice(), found.entry.playerPubkey, signerNodes, entryIdBytes);
    }

    const count = rerunIsAgreed({
      roundId: roundIdBytes, playerPubkey: found.entry.playerPubkey, contradictedRunId,
      records: this.round.reruns(roundIdBytes, entryIdBytes), signerNodes, slots: contract.gameVerifySlots,
      verify: (s, m, k) => schnorr.verify(s, m, k),
    });
    return { ...count, ...report };
  }

  /**
   * FILE A SLASH PROOF AGAINST EVERY SIGNER NODE THE RE-RUN CONTRADICTED (§13A, 5A.3B).
   *
   * "Every node that signed the contradicted result is slashed (§5A.3)." 5A.3B
   * step 1, anyone publishes the fraud proof; step 2, it is mechanically
   * checkable. So for each result this node holds whose run is the contradicted
   * one: a REPLAY_CONTRADICTS proof naming the canonical transcript, the signed
   * result and the bond the signer node's OWN advertisement names - filed only if
   * `slashHolds` says it slashes, kept beside its evidence, served, and posted
   * to the round's relays. The one judgement, that the replay differed, is this
   * node's own replay: it is the re-run's authoritative outcome and not the
   * contradicted one. Steps 3 and 5 are the arbitration set's.
   */
  async fileSlashProofs(roundIdBytes, entryIdBytes, contradictedRunId, authoritativeRunId) {
    return this.#fileFirstResultProofs(roundIdBytes, entryIdBytes, contradictedRunId,
      (myRun) => myRun !== hex(contradictedRunId) && myRun === hex(authoritativeRunId));
  }

  /**
   * THE FIRST RESULT'S SIGNERS, WHEN THE ENTRY ENDS VOID - OR FORFEIT BY §13C (§13A; RULED 2026-09-24, ruling C
   * steps 2 and 3: "the slashing of the first result's signers stands, because the objection that proved them wrong
   * already exists"). The same proof, evidence (the signer's own signed player result), check (`slashHolds`) and table
   * (slash_proofs) as `fileSlashProofs`, and the same dedupe. What differs is the verdict: there is no authoritative
   * re-run to agree with, so it is this node's own replay differing from the contradicted run - the fact the first
   * objection held on. Filed only when this node answers VOID by a second objection, or VOID or FORFEIT by §13C at the
   * re-run window's end; never while SUSPENDED or PROVISIONALLY_FINAL. Money is not touched.
   */
  async fileFirstResultSlashProofs(roundIdBytes, entryIdBytes) {
    const standing = finalityOf(this.round, roundIdBytes, entryIdBytes);
    // AND A LATE OBJECTION (§13A, WINDOW-10-SPEC): one that reached this seat after its close + 5 s suspends nothing and
    // the run is FINAL, but "a valid objection is also a fraud proof against every node that signed the contradicted
    // result ... that proof has no deadline: it is filed for slashing".
    const late = standing.state === 'FINAL' && standing.lateObjection && !standing.contradictedRunId;
    const ended = (standing.state === 'VOID' && (standing.secondObjection || standing.noQuorum))
      || (standing.state === 'FORFEIT' && standing.noQuorum) || late;
    if (!ended || !standing.runId)
      return { filed: [], refused: [`that entry has not ended VOID or FORFEIT after an objection (it is ${standing.state || 'without a result'}), so its first result's signers are not slashed yet`], published: 0 };
    const contradicted = Buffer.from(standing.secondObjection ? standing.contradictedRunId : standing.runId, 'hex');
    const report = await this.#fileFirstResultProofs(roundIdBytes, entryIdBytes, contradicted, (myRun) => myRun !== hex(contradicted));
    // AND BY NAME, THE ONES WHO ARE NOT FILED AGAINST: this node, whose own result is the replay; and a re-run signer
    // who never signed the contradicted result.
    const signedFirst = new Set();
    for (const r of this.round.results(roundIdBytes, entryIdBytes)) {
      try {
        const body = decodePlayerResult(splitSignedResult(r.bytes).body);
        if (hex(runId(body)) === hex(contradicted)) signedFirst.add(hex(body.nodePubkey));
      } catch { /* a record that does not decode signed nothing */ }
    }
    const me = hex(this.round.pubkey);
    report.refused.unshift(`${me.slice(0, 16)}: this node's own result, which is the replay`);
    const named = new Set([me]);
    for (const r of this.round.reruns(roundIdBytes, entryIdBytes)) {
      const who = hex(r.signerNodePubkey);
      if (named.has(who) || signedFirst.has(who)) continue;
      named.add(who);
      report.refused.push(`${who.slice(0, 16)}: signed the re-run, not the contradicted result`);
    }
    return report;
  }

  /** The body both first-result filings share: one proof per signer of `contradictedRunId`, on `differs(myRun)`. */
  async #fileFirstResultProofs(roundIdBytes, entryIdBytes, contradictedRunId, differs) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { filed: [], refused: ['no such round'], published: 0 };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const signerNodes = this.round.signerNodes(roundIdBytes);
    const report = { filed: [], refused: [], published: 0 };
    let canonical;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryIdBytes); }
    catch (e) { report.refused.push(e.message); return report; }

    const held = this.round.results(roundIdBytes, entryIdBytes);
    const mine = held.find((r) => hex(r.nodePubkey) === hex(this.round.pubkey));
    if (!mine) { report.refused.push('this node signed no result for that run, so it has no replay to accuse with'); return report; }
    const myRun = hex(runId(decodePlayerResult(splitSignedResult(mine.bytes).body)));
    const replayDiffers = differs(myRun);

    let adverts = null;
    try { adverts = this.advertsFor ? this.advertsFor(roundIdBytes) : null; } catch { adverts = null; }
    const filed = new Set(this.round.slashProofs(roundIdBytes, entryIdBytes).map((p) => hex(p.nodePubkey)));
    for (const r of held) {
      let body;
      try { body = decodePlayerResult(splitSignedResult(r.bytes).body); } catch { continue; }
      if (hex(runId(body)) !== hex(contradictedRunId)) continue;
      const who = hex(body.nodePubkey);
      if (filed.has(who)) continue;
      if (!signerNodes.some((k) => hex(k) === who)) { report.refused.push(`${who.slice(0, 16)}: ${who} is not on this round's committee`); continue; }
      const advert = adverts instanceof Map ? adverts.get(who) : null;
      if (!advert) { report.refused.push(`${who.slice(0, 16)}: no advertisement names its bond`); continue; }
      const proof = {
        roundId: roundIdBytes, playerPubkey: body.playerPubkey, nodePubkey: body.nodePubkey,
        transcriptHash: canonical.hash, signedResultId: resultId(body),
        bondTxid: advert.bondTxid, bondVout: advert.bondVout,
      };
      const check = slashHolds({
        proof, signedResult: r.bytes, advert, committee: signerNodes,
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
          if (put.ok) report.published += 1;
          else report.refused.push(`${relay}: kept no proof (${put.status})`);
        } catch (e) { report.refused.push(`${relay}: ${e.message}`); }
      }
    }
    return report;
  }

  /**
   * SLASH PROOFS AGAINST THE AGREED RE-RUN'S SIGNERS (§13A, §5A.3B; RULED 2026-09-24, slice C2c). Only once a
   * second valid objection has made the entry VOID - "the signers of that result are slashed as well" - and never
   * before: a re-run still PROVISIONALLY_FINAL, FINAL or not yet agreed has contradicted nobody. One REPLAY_CONTRADICTS
   * proof per agreeing re-run signer, the accused's own signed re-run beside it, checked by `slashHoldsOnRerun` with
   * this node's own re-run as the replay; stored once per signer and published to the round's relays once. Anyone
   * else - this node itself, a stranger, a key whose re-run is another outcome, a signer with no advertisement - is
   * refused by name and nothing is stored. The first result's signers are not filed against here (the next cut).
   */
  async fileRerunSlashProofs(roundIdBytes, entryIdBytes) {
    const report = { filed: [], refused: [], published: 0 };
    const row = this.round.get(roundIdBytes);
    if (!row) { report.refused.push('no such round'); return report; }
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const standing = finalityOf(this.round, roundIdBytes, entryIdBytes);
    if (standing.state !== 'VOID' || !standing.secondObjection || !standing.runId) {
      report.refused.push(`no second objection has made that entry VOID (it is ${standing.state || 'without a result'}), so no re-run signer is contradicted`);
      return report;
    }
    const agreedRunId = Buffer.from(standing.runId, 'hex');
    let canonical;
    try { canonical = this.round.canonicalTranscript(roundIdBytes, entryIdBytes); }
    catch (e) { report.refused.push(e.message); return report; }
    const signerNodes = this.round.signerNodes(roundIdBytes);
    const records = this.round.reruns(roundIdBytes, entryIdBytes);
    const own = records.find((r) => hex(r.signerNodePubkey) === hex(this.round.pubkey));
    let ownRun = null;
    try { ownRun = own ? runOf(decodeRerunResult(splitSignedRerun(own.bytes).body).result) : null; } catch { ownRun = null; }
    const replayDiffers = ownRun !== null && hex(ownRun) !== hex(agreedRunId);

    let adverts = null;
    try { adverts = this.advertsFor ? this.advertsFor(roundIdBytes) : null; } catch { adverts = null; }
    const filed = new Set(this.round.rerunSlashProofs(roundIdBytes, entryIdBytes).map((p) => hex(p.nodePubkey)));
    for (const r of records) {
      let x;
      try { x = decodeRerunResult(splitSignedRerun(r.bytes).body); } catch { continue; }
      const who = hex(x.result.nodePubkey);
      if (who === hex(this.round.pubkey)) { report.refused.push(`${who.slice(0, 16)}: this node's own re-run, which dissented`); continue; }
      if (filed.has(who)) continue;
      const advert = adverts instanceof Map ? adverts.get(who) : null;
      const proof = {
        roundId: roundIdBytes, playerPubkey: x.result.playerPubkey, nodePubkey: x.result.nodePubkey,
        transcriptHash: canonical.hash, signedResultId: rerunResultId(x),
        bondTxid: advert ? advert.bondTxid : new Uint8Array(32), bondVout: advert ? advert.bondVout : 0,
      };
      const check = slashHoldsOnRerun({
        proof, signedRerun: r.bytes, advert, committee: signerNodes, canonicalTranscriptHash: canonical.hash,
        agreedRunId, replayDiffers, verify: (sig, m, k) => schnorr.verify(sig, m, k),
      });
      if (!check.slashed) { report.refused.push(`${who.slice(0, 16)}: ${check.why}`); continue; }
      const id = slashProofId(proof);
      const record = joinRerunSlashEvidence(encodeSlashProof(proof), r.bytes);
      if (!this.round.putRerunSlashProof(roundIdBytes, entryIdBytes, x.result.nodePubkey, id, record)) continue;
      report.filed.push(who);
      for (const relay of contract.publicationRelays || []) {
        try {
          const put = await fetch(`${String(relay).replace(/\/+$/, '')}/slash/${hex(id)}`, { method: 'PUT', body: record });
          if (put.ok) report.published += 1;
          else report.refused.push(`${relay}: kept no proof (${put.status})`);
        } catch (e) { report.refused.push(`${relay}: ${e.message}`); }
      }
    }
    return report;
  }

  /** One re-run from a peer: about this round and player, from a joined signer node, and signed by it. */
  #keepPeerRerun(roundIdBytes, record, playerPubkey, signerNodes, entryIdBytes) {
    let x, signature;
    try {
      const split = splitSignedRerun(record);
      signature = split.signature;
      x = decodeRerunResult(split.body);
    } catch { return false; }
    if (hex(x.result.roundId) !== hex(roundIdBytes) || hex(x.result.playerPubkey) !== hex(playerPubkey)) return false;
    if (!signerNodes.some((s) => hex(s) === hex(x.result.nodePubkey))) return false;
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
    // A HEAD-TO-HEAD ENTRY: its result names its reveal record, built here from the reveals this seat holds
    {
      const row = this.round.get(roundIdBytes);
      if (row && this.#headToHead(decodeRoundContract(new Uint8Array(row.contract)))) {
        const rv = this.round.revealsOf(roundIdBytes).find((r) => hex(r.entryId) === hex(entryIdBytes));
        const rec = this.#revealRecord(entryIdBytes, rv);
        if (hex(transcriptBytesHash(rec)) === hex(transcriptHash)) return rec;
      }
    }
    // AN ENTRY THAT NEVER STARTED (§15 at the close): its FORFEIT names the empty
    // receipted transcript, which every signer node builds alike and none holds as marks.
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
    report.refused.push('no signer node served the transcript the agreed result names');
    return null;
  }

  /** One posting from a peer: about this round and player, from a joined signer node, and signed by it. */
  #keepPeerPosting(roundIdBytes, entryIdBytes, record, playerPubkey, signerNodes) {
    let p, signature;
    try {
      const split = splitSignedPosting(record);
      signature = split.signature;
      p = decodeTranscriptPosting(split.body);
    } catch { return false; }
    if (hex(p.roundId) !== hex(roundIdBytes) || hex(p.playerPubkey) !== hex(playerPubkey)) return false;
    if (!signerNodes.some((s) => hex(s) === hex(p.signerNodePubkey))) return false;
    let ok = false;
    try { ok = schnorr.verify(signature, transcriptPostingId(p), p.signerNodePubkey); } catch { ok = false; }
    if (!ok) return false;
    return this.round.putPosting(roundIdBytes, entryIdBytes, p.signerNodePubkey, record) === 1;
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
    // would take that signer node's row - and the signer node's true record, arriving later,
    // would be ignored as a duplicate. One peer could then stop any signer node's
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
   * A run this node has already signed is not replayed again: one signer node, one
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

    const work = this.pool.submit({ core: this.#coreOf(roundIdBytes),
      key: `${hex(roundIdBytes)}:${hex(entryIdBytes)}:retry`,
      objected: this.round.objected(roundIdBytes, entryIdBytes),
      ...this.#runFor(roundIdBytes, entryIdBytes),
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
