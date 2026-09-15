// THE REPLAY QUEUE, AND AN OBJECTION NEVER WAITS BEHIND A RUN NOBODY DISPUTED.
//
// PRIORITIES names the pool: worker threads, each importing the core once;
// "Priority: objected runs first, then top-ranked, then the rest. Capacity is
// MEASURED, not assumed." (Quoted without the package's own name, because the
// guard test that keeps this daemon to one door reads these files as TEXT -
// and a comment that mentions the core is exactly as suspicious as an import
// until somebody looks.)
//
// ORDER IS NOT ARRIVAL. A node has one machine and a round has many players,
// so everything cannot be replayed at once and something decides what goes
// first. First-come-first-served sounds fair and is the one rule an attacker
// can use: section 13A gives an objection a WINDOW, so flooding a node with
// undisputed runs at the moment somebody objects would push the objection past
// the end of it, and a veto that expires unheard is a veto that was never
// there. So an objection leaves the queue while an unobjected run sits, and
// that is the whole point rather than a tuning preference.
//
// WHAT THIS COSTS, SAID OUT LOUD: a stream of objections does starve the rest.
// That is the accepted trade - an objection has a deadline and an ordinary
// replay does not - and it is why the classes are three and not a score.
//
// IT IS NOT A SECOND DOOR. Nothing here touches the simulator; it decides only
// WHEN `replay.js` is asked, and `replay.js` is still the only file in this
// daemon that reaches the core.
import { replayInWorker } from './replay.js';

/** Objected first, then the board's leaders, then everybody else. */
export const OBJECTED = 0;
export const RANKED = 1;
export const REST = 2;

/**
 * WHICH QUEUE A JOB JOINS, and none of it is computed here.
 *
 * `objected` is a fact the node already holds - an objection was filed against
 * that run. `rank` is the board's, from letter 20, which builds the same order
 * on every node from signed finals; this file does not sort players and must
 * not, because a pool that decided who was winning would be a second
 * leaderboard. A job with neither is simply the rest.
 */
export const classOf = (job) => {
  if (job.objected) return OBJECTED;
  if (Number.isInteger(job.rank)) return RANKED;
  return REST;
};

export class ReplayPool {
  /**
   * `workers` is how many replays may run at once, and it defaults to ONE
   * because capacity is a measurement of a machine and not a number to guess.
   * A node that has measured its own says so; a node that has not gets the
   * number that cannot be wrong.
   */
  constructor({ workers = 1 } = {}) {
    if (!Number.isInteger(workers) || workers < 1)
      throw new RangeError('a pool runs at least one replay at a time');
    this.workers = workers;
    this.queues = [[], [], []];
    this.running = 0;
    /** The keys in the order they were STARTED - what a starvation claim is checked against. */
    this.order = [];
  }

  get waiting() { return this.queues.reduce((n, q) => n + q.length, 0); }

  /**
   * Hand a finished run to the pool.
   *
   * THERE IS NO ARGUMENT FOR WHAT DOES THE REPLAYING. It was going to take one
   * so a test could watch the order without starting threads, and that is a
   * hole: a caller who can hand in the replayer can hand in a replayer that
   * agrees with anything. The order is watched through `order` instead, on
   * real workers. Resolves with `replay`'s own answer,
   * unchanged - the pool never edits a verdict, it only decides when it is
   * asked for.
   */
  submit(job) {
    if (!job || !job.key) throw new Error('a replay job needs a key to be named by');
    return new Promise((resolve, reject) => {
      this.queues[classOf(job)].push({ job, resolve, reject });
      this.#pump();
    });
  }

  /**
   * THE ONE PLACE THE ORDER IS DECIDED: the highest-priority non-empty queue,
   * and FIFO inside it. Written as a loop over the three rather than as a sort,
   * because a comparator is where a tie-break quietly becomes a policy.
   */
  #take() {
    for (const q of this.queues) if (q.length) return q.shift();
    return null;
  }

  #pump() {
    while (this.running < this.workers) {
      const next = this.#take();
      if (!next) return;
      this.running++;
      this.order.push(next.job.key);
      // THE CORE THE ROUND NAMES travels with the job (M3 R1): the worker replays under it, or refuses.
      const { transcript, entry, options, core } = next.job;
      Promise.resolve()
        .then(() => replayInWorker(transcript, entry, { ...options, core }))
        .then(next.resolve, next.reject)
        .finally(() => { this.running--; this.#pump(); });
    }
  }
}
