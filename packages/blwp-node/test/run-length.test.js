// A RUN ENDS, AND IT ENDS WHERE THE CORE SAYS.
//
// Section 6 names `player_run_duration` and this Round Contract does not carry
// it - and never needed to. The core owns it as `BLOCK_TICKS` in
// `rules/gate.js`, counts it as `S_ELAPSED` while the run is LIVE so a late
// joiner gets a whole mission (0.8), and `genesis.js` writes that number into
// the config hash a round's `network_id` commits to. A second signed copy
// would be a second clock, which letter 21 forbade.
//
// MEASURED BEFORE ANY OF THIS EXISTED, and it is why the letter is not just a
// comment: a round naming 9000, one naming 4500 and one naming 1 were all
// accepted; 9600 ticks of a 9000-tick run were all stored and all replayed;
// and `transcriptBelongsToEntry` reported the run length as unchecked.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { TRUCK_BEFORE_FORK_HASH } from '../src/cores.js';
import { fromHex as fromHexForFork } from '../../protocol/src/hash.js';
import { Round } from '../src/round.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../src/cores.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { lastTickOfRun, runLengthIsTheCores } from '../../protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contractWith = (blockTicks) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
});
const entryOn = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const words = () => [45875, 0, 0, 0, 0];

/** Publish `count` ticks from `from`, 600 a batch, and answer what stuck. */
function drive(round, rid, eid, from, count) {
  let stored = 0;
  let refused = null;
  for (let first = from; first < from + count; first += 600) {
    const take = Math.min(600, from + count - first);
    const bytes = encodeInputBatch({
      roundId: rid, entryId: eid, previousHash: round.head(rid, eid),
      firstTick: first, ticks: Array.from({ length: take }, words), liquidations: [],
    });
    try { stored += round.batch(bytes); } catch (e) { refused = e.message; break; }
  }
  return { stored, refused };
}

// THE 82/90 HARD FORK (the owner 2026-10-01: "The round length must be part of the contract - not a fixed constant"): on the
// truck after the fork a round names its run length - any from 1 to BLOCK_TICKS opens, and the core ends its runs there;
// longer is refused by name. On the truck BEFORE the fork (its hash d15c39bb..., installed as the same core held to one
// length) only its own BLOCK_TICKS opens. Before the fork this test refused every length but BLOCK_TICKS on the one truck.
test('a round names its run length on the truck after the fork - 1 to 10800 opens, longer is refused; the truck before the fork takes only its 10800', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);
  for (const ticks of [BLOCK_TICKS, 4920, 1, BLOCK_TICKS - 1]) assert.ok(round.open(contractWith(ticks)), `a round naming ${ticks} was refused`);
  for (const ticks of [BLOCK_TICKS + 1, 0])
    assert.throws(() => round.open(contractWith(ticks)), new RegExp(`says a run is ${ticks} ticks, and btc-logistics truck runs 1 to ${BLOCK_TICKS}`));
  const before = (ticks) => ({ ...contractWith(ticks), simCoreHash: fromHexForFork(TRUCK_BEFORE_FORK_HASH), slashMinimumServed: 21 });
  assert.ok(round.open(before(BLOCK_TICKS)), 'a round of the truck before the fork, at its 10800, was refused');
  for (const ticks of [4920, BLOCK_TICKS - 1])
    assert.throws(() => round.open(before(ticks)), new RegExp(`says a run is ${ticks} ticks and this core ends one at ${BLOCK_TICKS}`));
  assert.match(runLengthIsTheCores({}).why, /names no run length/);
  assert.equal(runLengthIsTheCores(contractWith(BLOCK_TICKS), BLOCK_TICKS).blockTicks, BLOCK_TICKS);
});

test('a whole run is stored, and the tick after it is refused', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);
  const rid = round.open(contractWith(BLOCK_TICKS));
  const eid = round.enter(entryOn(rid));

  // EXACTLY THE RUN: every tick of it lands.
  const whole = drive(round, rid, eid, 0, BLOCK_TICKS);
  assert.equal(whole.refused, null, whole.refused);
  assert.equal(whole.stored, BLOCK_TICKS, 'a legal run of the full length was not stored');

  // AND ONE MORE BATCH IS AN INPUT FOR A RUN THAT IS OVER.
  const over = drive(round, rid, eid, BLOCK_TICKS, 600);
  assert.equal(over.stored, 0);
  assert.match(over.refused, new RegExp(`that run ends at tick ${BLOCK_TICKS - 1}`));
  assert.match(over.refused, /inputs past the end are inputs for a run that is over/);
});

test('a late joiner gets a whole run, counted from its own join tick', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);
  const rid = round.open(contractWith(BLOCK_TICKS));
  const eid = round.enter(entryOn(rid, 3000));

  // 0.8: the same mission duration even when late. The run ends 9000 ticks
  // after THIS entry's join, not 9000 after the round began.
  assert.equal(lastTickOfRun(3000, BLOCK_TICKS), 3000 + BLOCK_TICKS - 1);
  const whole = drive(round, rid, eid, 3000, BLOCK_TICKS);
  assert.equal(whole.refused, null, whole.refused);
  assert.equal(whole.stored, BLOCK_TICKS, 'a late joiner was cut short');

  const over = drive(round, rid, eid, 3000 + BLOCK_TICKS, 600);
  assert.match(over.refused, new RegExp(`that run ends at tick ${3000 + BLOCK_TICKS - 1}`));
});

test('replay refuses a transcript that reaches past the run, however it was got', () => {
  const entry = entryOn(b32(1));
  const ticks = [];
  for (let t = 0; t <= BLOCK_TICKS; t++) ticks.push({ tick: t, words: words() });

  // A node that never stored it can still be handed one - by a peer, by an
  // objection, by a file - so the bound is on the replay too and not only on
  // the door that stores.
  const over = replay({ ticks, liquidations: [] }, entry, { roundRandomness: b32(0xbe) });
  assert.equal(over.ok, false, 'an open-ended drive was replayed');
  assert.match(over.why, new RegExp(`that run ends at tick ${BLOCK_TICKS - 1}`));
  assert.match(over.why, new RegExp(`and that transcript reaches ${BLOCK_TICKS}`));

  const whole = replay({ ticks: ticks.slice(0, BLOCK_TICKS), liquidations: [] }, entry,
    { roundRandomness: b32(0xbe) });
  assert.equal(whole.ok, true, whole.why);
  assert.equal(whole.ticks, BLOCK_TICKS, 'a full legal run did not replay');
});

// AN 82 s ROUND (the 82/90 fork): its contract's 4920 ticks, carried with the core (coreForRound's runTicks) into the
// replay - the run ends at its tick 4919, the core ends it MISSED there, and one tick more is a transcript past the run.
test('an 82 s round replays to its own 4920 ticks: a whole run replays and ends MISSED, one tick more is refused', async () => {
  const { coreForRound } = await import('../src/cores.js');
  const found = coreForRound(contractWith(4920));
  assert.equal(found.ok, true, found.why);
  const core = { ...found.core, config: found.config, runTicks: found.runTicks };
  const entry = entryOn(b32(1));
  const ticks = [];
  for (let t = 0; t <= 4920; t++) ticks.push({ tick: t, words: [0, 0, 65536, 0, 0] });
  const over = replay({ ticks, liquidations: [] }, entry, { roundRandomness: b32(0xbe), core });
  assert.equal(over.ok, false, 'a drive past the 82 s run was replayed');
  assert.match(over.why, /that run ends at tick 4919/);
  const whole = replay({ ticks: ticks.slice(0, 4920), liquidations: [] }, entry, { roundRandomness: b32(0xbe), core });
  assert.equal(whole.ok, true, whole.why);
  assert.equal(whole.ticks, 4920);
  console.log('  FACTS (82 s replay):', JSON.stringify({ ticks: whole.ticks, outcome: whole.outcome, score: whole.score }));
  assert.equal(whole.outcome, 'FAILED', 'a braked truck at its 82 s run end did not end FAILED (MISSED)');
});

// M3 R1 R3 (the owner 2026-09-15 08:07: several cores and rule sets at once): a round's run length is its own
// core's under its config, not the truck's BLOCK_TICKS - measured on the round store itself.
test('a round\'s run length is its own core\'s under its config: the counter opens at its 120 and refuses 9000, and a store without it opens neither', async () => {
  const { COUNTER, CONFIGS } = await import('./cores/counter.js');
  const { installedCores } = await import('../src/cores.js');
  const { fromHex } = await import('../../protocol/src/hash.js');
  const [LOW] = CONFIGS;
  const counterRound = (blockTicks) => ({ ...contractWith(blockTicks), simCoreHash: fromHex(COUNTER.hash), configHash: LOW.hash });
  const withCounter = new Round(openStore(':memory:'), () => NOW + 1000, { cores: installedCores([COUNTER]) });
  assert.ok(withCounter.open(counterRound(LOW.config.ticks)));
  assert.throws(() => withCounter.open(counterRound(BLOCK_TICKS)),
    new RegExp(`says a run is ${BLOCK_TICKS} ticks and this core ends one at ${LOW.config.ticks}`));
  const truckOnly = new Round(openStore(':memory:'), () => NOW + 1000);
  assert.throws(() => truckOnly.open(counterRound(LOW.config.ticks)), /this signer node holds no core/);
  assert.throws(() => lastTickOfRun(3000), /counted from the round's run length/);
  assert.equal(lastTickOfRun(3000, LOW.config.ticks), 3000 + LOW.config.ticks - 1);
});
