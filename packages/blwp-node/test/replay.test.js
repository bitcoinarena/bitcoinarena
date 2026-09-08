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
import { replay, replayInWorker, agreeOnState, NO_SEED_RULE } from '../src/replay.js';
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
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick, worldSecret: b32(0x5e),
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
function played(ticks, { from = 0, liquidations = LIQUIDATIONS } = {}) {
  const due = new Map(liquidations);
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
function stored(ticks, { from = 0, chunk = 100, liquidations = LIQUIDATIONS } = {}) {
  const r = new Round(openStore(), () => 1234);
  const c = contract();
  const rid = r.open(c);
  const entry = entryFor(rid, from);
  const eid = r.enter(entry);

  const due = new Map(liquidations);
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
  const noSecret = replay(transcript, { ...entry, worldSecret: undefined });
  assert.equal(noSecret.ok, false);
  assert.equal(noSecret.why, NO_SEED_RULE);
  const noRnd = replay(transcript, entry);
  assert.equal(noRnd.ok, false);
  assert.match(noRnd.why, /no randomness/);
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

/**
 * THE SAME ANSWER, OFF THE DAEMON'S OWN THREAD.
 *
 * A replay is minutes of simulation; on the event loop the node would answer
 * nothing at all while it ran. A thread does not make it a live second
 * simulator - the run is already over and nothing here has a clock.
 */
test('the worker replays to the same hash at every mark', async () => {
  const TICKS = 600;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);

  const got = await replayInWorker(transcript, entry, { seedWord: SEED, marks: run.marks });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.stateHash, run.stateHash, 'the worker reached a different state');
  assert.equal(got.checked, 5);
  assert.equal(got.divergedAt, null);
  assert.equal(got.agrees, true);

  // and it is the same answer the daemon's own thread gives, field for field
  assert.deepEqual(got, replay(transcript, entry, { seedWord: SEED, marks: run.marks }));

  // AND A LATE RUN CROSSES THE THREAD WITH ITS OWN START TICK. The entry goes
  // through structured clone; a worker that rebuilt the run from zero would
  // reach a different state and call the player a liar from another thread.
  const FROM = 50;
  const late = played(400, { from: FROM });
  const lateStore = stored(400, { from: FROM });
  const lateGot = await replayInWorker(lateStore.transcript, lateStore.entry,
    { seedWord: SEED, marks: late.marks });
  assert.equal(lateGot.ok, true, lateGot.why);
  assert.equal(lateGot.stateHash, late.stateHash, 'the worker replayed a late run from the wrong tick');
  assert.equal(lateGot.agrees, true);

  // a refusal survives the thread boundary as a refusal, not as a crash
  const noSeed = await replayInWorker(transcript, { ...entry, worldSecret: undefined });
  assert.equal(noSeed.ok, false);
  assert.equal(noSeed.why, NO_SEED_RULE);
});

/**
 * FIVE OF SEVEN, EACH FROM ITS OWN TABLES.
 *
 * Seven independent stores take the same batches through the protocol's
 * encoder, and each replays what IT has. Until now a node could only count
 * signatures over a number the player handed it; this is seven nodes each
 * computing the answer, which is what makes "five agree" worth anything.
 */
test('seven nodes each replay their own tables and five of seven make it final', async () => {
  const TICKS = 600;
  const run = played(TICKS);
  const SLOTS = 7;

  // Six honest stores, and a seventh whose batches never carried the
  // liquidations - a real difference in what it holds, not a doctored answer.
  const nodes = [];
  for (let i = 0; i < SLOTS; i++) {
    const honest = i < 6;
    const { transcript, entry } = stored(TICKS, honest ? {} : { liquidations: [] });
    const got = await replayInWorker(transcript, entry, { seedWord: SEED, marks: run.marks });
    nodes.push({ nodePubkey: b32(0xa0 + i), ...got });
  }

  const six = nodes.filter((n) => n.stateHash === run.stateHash).length;
  assert.equal(six, 6, 'the honest stores did not all reach the played state');
  assert.equal(nodes[6].stateHash !== run.stateHash, true, 'the odd store agreed anyway');
  assert.equal(nodes[6].agrees, false, 'the odd store matched the player\'s marks');

  const settled = agreeOnState(nodes, { slots: SLOTS });
  assert.equal(settled.ok, true, settled.why);
  assert.equal(settled.final, true, settled.why);
  assert.equal(settled.stateHash, run.stateHash, 'the committee settled on a state nobody played');
  assert.equal(settled.needed, 5, 'the threshold is not five of seven');
  assert.equal(settled.agreed, 6);

  // FIVE IS ENOUGH AND FOUR IS NOT, and neither number is written here: the
  // threshold comes off the contract's slots through receiptsNeeded.
  const five = agreeOnState(nodes.slice(0, 5), { slots: SLOTS });
  assert.equal(five.final, true, five.why);
  const four = agreeOnState(nodes.slice(0, 4), { slots: SLOTS });
  assert.equal(four.final, false);
  assert.equal(four.stateHash, null, 'a state was named without the threshold');
  assert.match(four.why, /4 of 5 agree/);

  // A NODE COUNTED TWICE IS NOT TWO NODES.
  const doubled = [nodes[0], nodes[1], nodes[2], nodes[3], { ...nodes[0] }];
  assert.equal(agreeOnState(doubled, { slots: SLOTS }).ok, false);
  assert.match(agreeOnState(doubled, { slots: SLOTS }).why, /answered twice/);

  // and a committee size nobody has a threshold for is refused, not guessed
  assert.match(agreeOnState(nodes, { slots: 5 }).why, /no committee threshold for 5/);
});

/**
 * A NODE THAT COULD NOT REPLAY DOES NOT COUNT AS AGREEING.
 */
test('a node that refused to replay is counted as refusing, not as agreeing', async () => {
  const TICKS = 300;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);
  const answer = await replayInWorker(transcript, entry, { seedWord: SEED });

  const nodes = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    nodePubkey: b32(0xb0 + i),
    ...(i < 4 ? answer : replay(transcript, entry)),      // three have no seed
  }));

  assert.equal(nodes[0].stateHash, run.stateHash);
  const settled = agreeOnState(nodes, { slots: 7 });
  assert.equal(settled.final, false, 'refusals were counted towards the threshold');
  assert.equal(settled.agreed, 4);
  assert.equal(settled.refused, 3);
});
