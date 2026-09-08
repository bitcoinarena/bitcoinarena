// LATE JOIN: A RUN BEGINS WHERE THE ENTRY SAYS IT JOINED.
//
// 0.8: "A round supports a dynamically growing number of competitors... Late
// join is a normal feature, not merely reconnect. Each accepted entrant
// receives the same contract-defined mission duration `T_run`, even when
// wall-clock start times differ."
//
// Section 1: "All accepted players belong to the same logical round and payout
// pool. Every player receives the same mission duration `T_run`. Late join is
// normal." Section 7: "Late joins simply add more Entry Contracts. The Round
// Contract is never rewritten."
//
// So there is nothing to catch up to - 0.10 gives every player a private world
// and a late entrant's begins at their own tick. What CAN go wrong is the
// transcript claiming to begin somewhere else.
//
// Measured before this file existed: an entry that joined at tick 50 had its
// transcript accepted beginning at 0, at 50 and at 500 - all three - because
// `checkTranscript` is handed a transcript and never the entry it is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { batchId } from '../src/batch.js';
import { entryId } from '../src/contracts.js';
import {
  GENESIS, checkTranscript, flatten, transcriptBelongsToEntry,
} from '../src/transcript.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entryAt = (joinTick, over = {}) => ({
  roundId: b32(1), playerPubkey: b32(7), sessionPubkey: b32(8), stakeCommitment: b32(9),
  stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, joinTick, worldSecret: b32(0x5e), ...over,
});

/** A chain of `n` batches of three ticks, beginning at `first`. */
const runFrom = (first, eid, n = 3, liquidations = []) => {
  const batches = [];
  let prev = GENESIS;
  for (let k = 0; k < n; k++) {
    const at = first + k * 3;
    batches.push({
      roundId: b32(1), entryId: eid, previousHash: prev, firstTick: at,
      ticks: Array.from({ length: 3 }, (_, i) => [65536, at + i, 0, 0, 0]),
      liquidations: k === 1 ? liquidations : [],
    });
    prev = batchId(batches[k]);
  }
  return { roundId: b32(1), entryId: eid, batches };
};

/**
 * A LATE ENTRANT'S TRANSCRIPT BEGINS AT THEIR JOIN TICK, and one that begins
 * anywhere else does not belong to them.
 */
test('a transcript begins where the entry that signed for it says it joined', () => {
  const entry = entryAt(50);
  const eid = entryId(entry);

  const honest = transcriptBelongsToEntry(runFrom(50, eid), entry);
  assert.equal(honest.ok, true, honest.why);
  assert.equal(honest.joinTick, 50);

  // EARLIER THAN THEY JOINED: a run that started before the player was in the
  // round. `checkTranscript` accepted this, and still does - it is a chain, it
  // simply is not this entry's.
  const early = transcriptBelongsToEntry(runFrom(0, eid), entry);
  assert.equal(early.ok, false, 'a run that began before the player joined was accepted');
  assert.match(early.why, /begins at tick 0 and that entry joined at 50/);
  assert.equal(checkTranscript(runFrom(0, eid)).ok, true,
    'the chain itself is fine, which is why this needed its own check');

  // LATER: four hundred ticks nobody published, and the run looks continuous
  const late = transcriptBelongsToEntry(runFrom(500, eid), entry);
  assert.equal(late.ok, false);
  assert.match(late.why, /begins at tick 500 and that entry joined at 50/);

  // one tick either side is still the wrong start
  for (const at of [49, 51])
    assert.equal(transcriptBelongsToEntry(runFrom(at, eid), entry).ok, false, `tick ${at}`);
});

/**
 * AND IT IS THAT ENTRY'S. Whoever brings the transcript does not also choose
 * what it is checked against - the discipline `censusRootMatchesRound` needed
 * for its entries and `ghostBinds` for its transcript.
 */
test('a transcript is checked against the entry it names, not one somebody brought', () => {
  const entry = entryAt(50);
  const eid = entryId(entry);
  const other = entryAt(50, { playerPubkey: b32(0x55) });

  assert.match(transcriptBelongsToEntry(runFrom(50, eid), other).why,
    /a different entry than the transcript names/);

  // an entry from another round, with the transcript's own id forced on
  const foreign = entryAt(50, { roundId: b32(9) });
  const t = runFrom(50, entryId(foreign));
  assert.match(transcriptBelongsToEntry({ ...t, roundId: b32(1) }, foreign).why,
    /for another round/);

  // and the answers that are refusals rather than crashes
  assert.match(transcriptBelongsToEntry(undefined, entry).why, /not a transcript/);
  assert.match(transcriptBelongsToEntry(runFrom(50, eid), {}).why, /names no join tick/);
  assert.match(transcriptBelongsToEntry({ roundId: b32(1), entryId: eid, batches: [] }, entry).why,
    /carries no inputs/);
});

/**
 * A RUN THAT BEGINS AT FIFTY REPLAYS AS ITSELF, not as a run that began at
 * zero. `flatten` rebases the liquidation ticks to an index into the rows it
 * returns, and its own comment says why: "a transcript that begins at tick 50
 * would otherwise put a strike at index 51 of a two-element array - that is,
 * nowhere - and the replay would be a different round with nothing to say it
 * had gone wrong."
 */
test('a late transcript flattens to its own ticks, with the strikes rebased', () => {
  const entry = entryAt(50);
  const eid = entryId(entry);
  const t = runFrom(50, eid, 3, [[54, 99 * 65536]]);

  const flat = flatten(t);
  assert.equal(flat.firstTick, 50, 'the run forgot where it began');
  assert.equal(flat.ticks.length, 9);
  assert.deepEqual(flat.ticks[0], [65536, 50, 0, 0, 0]);
  assert.deepEqual(flat.ticks[8], [65536, 58, 0, 0, 0]);

  // the strike is at absolute tick 54, which is index 4 of this run
  assert.deepEqual(flat.liquidations, [[4, 99 * 65536]]);

  // the same run beginning at zero has the same shape and a different index,
  // so the rebasing is doing something rather than passing the number through
  const early = flatten(runFrom(0, eid, 3, [[4, 99 * 65536]]));
  assert.equal(early.firstTick, 0);
  assert.deepEqual(early.liquidations, [[4, 99 * 65536]]);
  assert.notDeepEqual(flat.ticks[0], early.ticks[0], 'the two runs are the same rows');
});

/**
 * AND NOTHING PAST THE HEAD. A mark on an input head the transcript does not
 * reach is refused for a late run exactly as for one that began at zero -
 * §11's "a transcript whose inputs were never published cannot be replayed".
 */
test('a late run refuses a mark on inputs it never published', () => {
  const entry = entryAt(50);
  const eid = entryId(entry);
  const t = runFrom(50, eid);

  assert.equal(checkTranscript(t).ok, true);

  // a batch that does not follow the one before it breaks the chain, wherever
  // the run began
  const broken = { ...t, batches: t.batches.map((b, i) => (i === 1 ? { ...b, previousHash: b32(9) } : b)) };
  const no = checkTranscript(broken);
  assert.equal(no.ok, false);
  assert.equal(no.at, 1);

  // and a run whose ticks jump is refused with the tick it expected, so a late
  // joiner cannot quietly skip the middle of their own run
  const gap = { ...t, batches: t.batches.map((b, i) => (i === 2 ? { ...b, firstTick: 90,
    ticks: b.ticks.map((w, k) => [65536, 90 + k, 0, 0, 0]) } : b)) };
  const jumped = checkTranscript(gap);
  assert.equal(jumped.ok, false);
  assert.match(jumped.why, /expected tick 56, got 90/);
});

/**
 * WHAT THIS LETTER CANNOT SAY, said out loud. 0.8's "same contract-defined
 * mission duration T_run" needs `player_run_duration`, which section 6 names
 * and this Round Contract does not carry.
 */
test('the run length is reported as unchecked rather than assumed', () => {
  const entry = entryAt(50);
  const seen = transcriptBelongsToEntry(runFrom(50, entryId(entry)), entry);

  assert.equal(seen.unchecked.length, 1);
  assert.match(seen.unchecked[0], /player_run_duration/);

  // a run of three batches and a run of ten both belong to the entry: how long
  // is allowed is not a question this can answer
  const long = transcriptBelongsToEntry(runFrom(50, entryId(entry), 10), entry);
  assert.equal(long.ok, true, long.why);
  assert.equal(toHex(entryId(entry)).length, 64);
});
