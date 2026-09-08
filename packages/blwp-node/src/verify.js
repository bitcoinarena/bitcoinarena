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
import { resultFrom, signResult } from './verdict.js';
import { joinSignedResult } from '../../protocol/src/result.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';

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
  constructor(round, { randomnessFor = NO_RANDOMNESS_SOURCE, pool = new ReplayPool() } = {}) {
    this.round = round;
    this.randomnessFor = randomnessFor;
    this.pool = pool;
    /** What the last close produced, so a caller can wait for it or read it. */
    this.done = [];
    /** What it QUEUED, and how - so a node can be asked what it thought it had. */
    this.queued = [];
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
      const transcript = this.round.transcript(roundIdBytes, entryId);
      const objected = this.round.objected(roundIdBytes, entryId);
      this.queued.push({ entryId, objected });
      return this.pool.submit({
        key: `${hex(roundIdBytes)}:${hex(entryId)}`,
        objected,
        transcript,
        entry,
        options: { roundRandomness: this.randomnessFor({ contract, roundIdBytes, entry, entryId }) },
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
    return { entryId, stored: true, resultId: signed.resultId, outcome: built.result.outcome };
  }
}

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
