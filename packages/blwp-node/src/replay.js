// THE DAEMON REPLAYS A RUN. IT DOES NOT RUN ONE BESIDE THE PLAYER.
//
// `blwp-client/src/client.js` opens by saying why this file did not exist:
// "the node is a store... `blwp-node/src` imports no core ON PURPOSE, because
// a daemon that recomputed the state would be a second simulator and then two
// of them could disagree." That argument is against a node stepping a round
// LIVE, in parallel with the player - two engines running at once, each with
// its own idea of the present, and no way to say which is the game.
//
// This is the other thing, and section 13 requires it: seven nodes replay a
// player's FINISHED run and five must agree. That is one simulator run twice
// over the same inputs, which is the only claim determinism ever made. A node
// that cannot do it has to take the player's word for the state hash it signs
// a receipt over, and "five of seven agree" degrades to "five of seven were
// told the same thing".
//
// So the core is imported HERE and nowhere else in the daemon. One door, and
// it opens on a transcript that is already stored and already finished.
//
// THE SHAPE IS `core/tools/replay.js`, whose own header said this was coming:
// "this is the shape the node's replay pool needs - the difference there is
// that it runs in a worker and the transcript comes off the wire rather than
// off disk." Same loop, same order, no second reading of the rules.
import { init, step, submitLiquidation } from '../../core/src/sim.js';
import { hash } from '../../core/src/state.js';
import { INPUT_WORDS } from '../../protocol/src/batch.js';

const hex = (b) => {
  if (typeof b === 'string') return b.toLowerCase();
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
};

/**
 * WHY A SEED IS ASKED FOR AND NEVER DERIVED HERE.
 *
 * IMPLEMENTATION.md names the player sub-seed as
 * `H(round_randomness || pubkey || secret || join_tick)`. Three of those four
 * are on signed objects a node already holds. `secret` is the PLAYER's, and
 * section 0.10's private world says nothing about when or whether it reaches a
 * verifier: there is no reveal message, no entry field, and no clause naming
 * one. Writing that hash here would settle a protocol question by implementing
 * it, which is the BOND_MARKER and checkpoint class of decision.
 *
 * So this refuses rather than guesses. A test may hand in a number it owns -
 * that is a fixture measuring the loop, not a rule about rounds - and a real
 * round cannot be replayed until somebody says where the secret comes from.
 * The refusal says so in those words, so nobody reads the gap as a bug.
 */
export const NO_SEED_RULE = 'no seed derivation is settled: the player sub-seed is '
  + 'H(round_randomness || pubkey || secret || join_tick) and `secret` is the player\'s, '
  + 'with no clause saying it ever reaches a verifier - so a seed must be handed in';

/**
 * REPLAY ONE PLAYER'S RUN FROM WHAT THE NODE ALREADY STORES.
 *
 * `transcript` is `Round#transcript()`: absolute tick numbers with five words
 * each, and sparse `[tick, size]` liquidations. `entry` is the player's signed
 * Entry Contract, which is where the START tick comes from - letter 19 fixed
 * that a late run begins at the tick its own entry names, so a replay that
 * began at zero would be replaying a different run from the one played.
 *
 * `marks` are the player's own checkpoints: `{ tick, stateHash }`. Each is
 * compared against the state THIS core reaches at that tick, and the first
 * that disagrees is named. A disagreement is not decided here - section 13
 * needs five of seven and one node is not a committee - it is reported.
 */
export function replay(transcript, entry, { seedWord, marks = [] } = {}) {
  if (!Number.isInteger(seedWord)) return { ok: false, why: NO_SEED_RULE };
  if (!transcript || !Array.isArray(transcript.ticks))
    return { ok: false, why: 'that is not a transcript this node stored' };
  if (!entry || !Number.isInteger(entry.joinTick))
    return { ok: false, why: 'that entry names no join tick to start from' };

  const { ticks } = transcript;
  const start = entry.joinTick;
  if (ticks.length === 0) return { ok: false, why: 'that transcript carries no ticks' };
  if (ticks[0].tick !== start)
    return { ok: false, why: `that transcript starts at tick ${ticks[0].tick} and the entry joins at ${start}` };

  // A GAP IS NOT A SHORTER RUN. Ticks are absolute precisely so a hole shows
  // as a hole; replaying across one would produce a state nobody played and a
  // hash that disagrees for a reason that has nothing to do with the player.
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i].tick !== start + i)
      return { ok: false, why: `the transcript jumps from tick ${ticks[i - 1].tick} to ${ticks[i].tick}` };
    if (!Array.isArray(ticks[i].words) || ticks[i].words.length !== INPUT_WORDS)
      return { ok: false, why: `tick ${ticks[i].tick} does not carry five words` };
  }

  // BEFORE THAT TICK, which is what the golden vectors say and what
  // `core/tools/replay.js` does: "liquidations are [tick, size] pairs handed
  // to submitLiquidation BEFORE that tick". After it would be a different
  // game - the strike would land a tick late, every tick, and only in the
  // replay.
  const due = new Map((transcript.liquidations || []).map(([at, size]) => [at, size]));
  const want = new Map(marks.map((m) => [m.tick, hex(m.stateHash)]));

  const st = init(seedWord);
  let checked = 0;
  let divergedAt = null;

  // A mark AT the join tick is the state before any input, which a player can
  // legitimately publish; the loop below only sees ticks it steps, so it is
  // checked here.
  const atStart = want.get(start);
  if (atStart !== undefined) { checked++; if (hash(st) !== atStart) divergedAt = start; }

  for (const t of ticks) {
    if (due.has(t.tick)) submitLiquidation(st, due.get(t.tick));
    step(st, t.words[0], t.words[1], t.words[2], t.words[3], t.words[4]);

    // A CHECKPOINT AT TICK N IS THE STATE AFTER N HAS BEEN STEPPED. The
    // client's own marks are made that way - it drives the core and then
    // publishes at the tick it has reached - so the comparison is here, after
    // the step, and not before the next one.
    const at = want.get(t.tick + 1);
    if (at !== undefined) {
      checked++;
      if (hash(st) !== at && divergedAt === null) divergedAt = t.tick + 1;
    }
  }

  return {
    ok: true,
    ticks: ticks.length,
    liquidations: due.size,
    stateHash: hash(st),
    checked,
    unchecked: marks.length - checked,
    divergedAt,
    agrees: divergedAt === null,
  };
}
