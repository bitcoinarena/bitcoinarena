// THE NODE REACHES THE SAME STATE THE PLAYER DID, FROM WHAT IT ALREADY STORED.
//
// Section 13 makes a result final when five of seven nodes agree, and until a
// node can replay a run it agrees to whatever it was told: the state hash on a
// checkpoint is the player's own number, and a receipt over it is a receipt
// over a claim. This is the first half of that - one node, one finished run,
// and the same hash out.
//
// It is NOT a live second simulator. Nothing here steps alongside anybody. The
// run is over, the transcript is in the node's own tables, and the replay is
// the same core over the same inputs in the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replay, NO_SEED_RULE } from '../src/replay.js';
import { init, step, submitLiquidation } from '../../core/src/sim.js';
import { hash } from '../../core/src/state.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick,
});

/**
 * THE SEED IS THE FIXTURE'S OWN NUMBER AND NOT A RULE.
 *
 * `replay` refuses without one because the derivation is unsettled: the player
 * sub-seed is H(round_randomness || pubkey || secret || join_tick) and
 * `secret` is the player's, with no clause putting it in front of a verifier.
 * The test owns this 7 the way `blwp-client/test/checkpoint.test.js` owns its
 * `core.init(7)`; nothing here says a round's seed is 7.
 */
const SEED = 7;

/** A run: five Q16.16 words a tick, the order `step` takes them in. */
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const LIQUIDATIONS = [[37, 3 * 65536], [311, 9 * 65536]];

/**
 * THE PLAYER'S RUN, driven straight off the core the way the client drives the
 * bundle it is drawing from. These hashes are the thing the node has to reach.
 */
function played(ticks, { from = 0 } = {}) {
  const due = new Map(LIQUIDATIONS);
  const st = init(SEED);
  const marks = [];
  for (let i = 0; i < ticks; i++) {
    const at = from + i;
    if (due.has(at)) submitLiquidation(st, due.get(at));
    step(st, ...wordsAt(at));
    if ((at + 1) % 120 === 0) marks.push({ tick: at + 1, stateHash: hash(st) });
  }
  return { marks, stateHash: hash(st) };
}

/** The same run, put through the daemon's door: batches in, transcript out. */
function stored(ticks, { from = 0, chunk = 100 } = {}) {
  const r = new Round(openStore(), () => 1234);
  const c = contract();
  const rid = r.open(c);
  const entry = entryFor(rid, from);
  const eid = r.enter(entry);

  const due = new Map(LIQUIDATIONS);
  let previousHash = GENESIS;
  for (let i = 0; i < ticks; i += chunk) {
    const n = Math.min(chunk, ticks - i);
    const first = from + i;
    const rows = [];
    for (let k = 0; k < n; k++) rows.push(wordsAt(first + k));
    const liq = [...due].filter(([at]) => at >= first && at < first + n);
    const b = {
      roundId: rid, entryId: eid, previousHash, firstTick: first, ticks: rows, liquidations: liq,
    };
    // `batch` returns how many ticks were NEW, and throws on a broken chain or
    // a gap, so a wrong fixture fails loudly here rather than quietly storing
    // half a run.
    assert.equal(r.batch(encodeInputBatch(b)), n, 'the node did not store every tick of a batch');
    previousHash = batchId(b);
  }
  return { round: r, rid, eid, entry, transcript: r.transcript(rid, eid) };
}

/**
 * THE NUMBER THAT CLOSES THE SLICE: the same hash, from two runs of the core
 * over the same inputs - one driven directly, one rebuilt from the node's
 * tables through the protocol's own encoder.
 */
test('the node replays a stored run to the same state hash the player reached', () => {
  const TICKS = 600;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);

  assert.equal(transcript.ticks.length, TICKS, 'the store did not keep every tick');
  assert.equal(transcript.liquidations.length, LIQUIDATIONS.length);

  const got = replay(transcript, entry, { seedWord: SEED, marks: run.marks });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.stateHash, run.stateHash, 'the node reached a different state from the player');
  assert.equal(got.ticks, TICKS);
  assert.equal(got.liquidations, LIQUIDATIONS.length);

  // EVERY MARK, not merely the last one: a run that agrees only at the end
  // could have parted company and come back, and section 13B's equivocation
  // case is exactly that.
  assert.equal(run.marks.length, 5);
  assert.equal(got.checked, 5, 'a mark was not compared');
  assert.equal(got.unchecked, 0);
  assert.equal(got.divergedAt, null);
  assert.equal(got.agrees, true);
});

/**
 * AND A LATE RUN REPLAYS FROM ITS OWN ENTRY'S TICK, not from zero. Letter 19
 * fixed the start; a replay that ignored it would rebuild a different run and
 * call the player a liar.
 */
test('a late joiner replays from the tick its entry names', () => {
  const FROM = 50, TICKS = 400;
  const run = played(TICKS, { from: FROM });
  const { transcript, entry } = stored(TICKS, { from: FROM });

  assert.equal(entry.joinTick, FROM);
  assert.equal(transcript.ticks[0].tick, FROM);

  const got = replay(transcript, entry, { seedWord: SEED, marks: run.marks });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.stateHash, run.stateHash);
  assert.equal(got.agrees, true);
  assert.equal(got.checked, run.marks.length);

  // starting at zero instead is a different run, and the fixture can tell
  assert.notEqual(played(TICKS, { from: 0 }).stateHash, run.stateHash);
});

/**
 * THE FIRST TICK THAT DISAGREES IS NAMED. "Somewhere in ten minutes" is not a
 * report anybody can act on; section 10 wants checkpoints so a disagreement
 * has a place, and this is what makes the place useful.
 */
test('a mark that disagrees is reported at its own tick, and the first one wins', () => {
  const TICKS = 600;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);

  const lied = run.marks.map((m, i) => (i === 1 || i === 3
    ? { tick: m.tick, stateHash: 'f'.repeat(64) } : m));
  const got = replay(transcript, entry, { seedWord: SEED, marks: lied });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.divergedAt, run.marks[1].tick, 'the wrong tick was named');
  assert.equal(got.agrees, false);
  assert.equal(got.checked, 5, 'a bad mark stopped the rest from being checked');

  // and the state hash is still the node's own answer, not the claim
  assert.equal(got.stateHash, run.stateHash);
});

/**
 * LIQUIDATIONS ARE PART OF THE RUN, AND THEY ARRIVE BEFORE THEIR TICK.
 *
 * The batch carries them because the five words cannot: "a transcript with
 * only the five would replay a round with no strike, no crater and no fallout
 * in it - a different game from the one that was played."
 */
test('a dropped or late liquidation is a different run', () => {
  const TICKS = 600;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);

  const without = { ...transcript, liquidations: [] };
  assert.notEqual(replay(without, entry, { seedWord: SEED }).stateHash, run.stateHash,
    'dropping every liquidation reached the same state, so the fixture cannot see them');

  const late = { ...transcript, liquidations: transcript.liquidations.map(([at, s]) => [at + 1, s]) };
  assert.notEqual(replay(late, entry, { seedWord: SEED }).stateHash, run.stateHash,
    'a liquidation one tick late reached the same state, so the order is not pinned');
});

/**
 * WHAT IT REFUSES. A replay that quietly filled a hole would produce a state
 * nobody played and then blame the player for it.
 */
test('the replay refuses a seed it was not given, a wrong start, and a gap', () => {
  const TICKS = 300;
  const { transcript, entry } = stored(TICKS);

  // THE SEED IS NOT INVENTED HERE. 0.10's private world does not say where
  // `secret` comes from, so a real round is not replayable yet and the refusal
  // says which clause is missing rather than looking like a bug.
  const noSeed = replay(transcript, entry);
  assert.equal(noSeed.ok, false);
  assert.equal(noSeed.why, NO_SEED_RULE);
  assert.match(noSeed.why, /`secret` is the player's/);
  assert.equal(replay(transcript, entry, { seedWord: 1.5 }).ok, false, 'a fractional seed was accepted');

  // a transcript that does not begin where the entry says
  const shifted = { ...transcript, ticks: transcript.ticks.slice(1) };
  const off = replay(shifted, entry, { seedWord: SEED });
  assert.equal(off.ok, false);
  assert.match(off.why, /starts at tick 1 and the entry joins at 0/);

  // a hole in the middle
  const holed = { ...transcript, ticks: [...transcript.ticks.slice(0, 100), ...transcript.ticks.slice(101)] };
  const gap = replay(holed, entry, { seedWord: SEED });
  assert.equal(gap.ok, false);
  assert.match(gap.why, /jumps from tick 99 to 101/);

  // and a tick that is not five words
  const short = { ...transcript, ticks: transcript.ticks.map((t, i) => (i === 7 ? { tick: t.tick, words: [1, 2, 3] } : t)) };
  assert.match(replay(short, entry, { seedWord: SEED }).why, /tick 7 does not carry five words/);
});
