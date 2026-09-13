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
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replay } from '../src/replay.js';
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
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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

test('a round that says a run is some other length is not a shorter round', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);

  // The core's own number opens.
  assert.ok(round.open(contractWith(BLOCK_TICKS)));

  // Anything else is refused BY NAME, and both directions are wrong: a shorter
  // round would have the node bounding batches the simulator would not stop
  // at, and a longer one promises ticks the simulator will never run.
  for (const ticks of [4500, 1, BLOCK_TICKS - 1, BLOCK_TICKS + 1]) {
    assert.throws(() => round.open(contractWith(ticks)),
      new RegExp(`says a run is ${ticks} ticks and this core ends one at ${BLOCK_TICKS}`),
      `a round naming ${ticks} was stored`);
  }
  assert.match(runLengthIsTheCores({}).why, /names no run length/);
  assert.equal(runLengthIsTheCores(contractWith(BLOCK_TICKS)).blockTicks, BLOCK_TICKS);
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
  assert.equal(lastTickOfRun(3000), 3000 + BLOCK_TICKS - 1);
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
