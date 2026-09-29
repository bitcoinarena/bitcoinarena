// THE FIRST MARK AGAINST THE START DEADLINE, AS A PREDICATE (§15, §16, §13C):
// a first mark in time decides nothing; one signed after join tick + deadline
// is FORFEIT (the player's own act - never a refund); no mark decides nothing
// (not ENTRY_VOID, not FORFEIT: §15's hole).
//
// The numbers are the measured ones: join tick 0, first mark at tick 60 (the
// built page), 720 after one timed-out 10 s input wait, and the fixtures'
// single first marks at 1197 (W5b's old plant) and 1320 (forfeit.test).
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';

import { firstMarkOutcome, startDeadlineOf } from '../src/first-mark.js';
import { START_DEADLINE_TICKS } from '../src/constants.js';
import { FORFEIT, ENTRY_VOID } from '../src/payout.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../src/constants.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const said = (joinTick, deadlineTicks, firstMark) => firstMarkOutcome({ joinTick, deadlineTicks, firstMark }).outcome;

test('on a round that names the tight line of 120: in time decides nothing, after it is FORFEIT, no mark decides nothing', () => {
  const facts = {
    markAt60: said(0, 120, { tick: 60 }),
    markAt1320: said(0, 120, { tick: 1320 }),
    markAt1197: said(0, 120, { tick: 1197 }),
    noMark: said(0, 120, null),
  };
  console.log('  FACTS (first mark, deadline 120):', JSON.stringify(facts));
  assert.deepEqual(facts, { markAt60: null, markAt1320: FORFEIT, markAt1197: FORFEIT, noMark: null });
  // NO MARK YET DECIDES NOTHING HERE: the walk-away is §15's FORFEIT, decided at the node's door once the start window
  // has passed (ALL-BUT-MIN-1727) - never ENTRY_VOID
  assert.equal(firstMarkOutcome({ joinTick: 0, deadlineTicks: 120, firstMark: null }).outcome, null);
  assert.match(firstMarkOutcome({ joinTick: 0, deadlineTicks: 120, firstMark: null }).why, /not ENTRY_VOID - a walk-away is §15's FORFEIT, decided at the door/);
});

test('a late first mark is never a refund: FORFEIT, not ENTRY_VOID (§13C)', () => {
  const late = firstMarkOutcome({ joinTick: 0, deadlineTicks: START_DEADLINE_TICKS, firstMark: { tick: 1320 } });
  assert.equal(late.outcome, FORFEIT);
  assert.notEqual(late.outcome, ENTRY_VOID);
  assert.match(late.why, /player's own act, not a refund/);
});

test('the omitted default is the page\'s window: the measured honest first marks are in time, the fixture plants are not', () => {
  const d = START_DEADLINE_TICKS;
  const facts = {
    defaultDeadline: d,
    pageFirstMark60: said(0, d, { tick: 60 }),
    afterOneInputWait720: said(0, d, { tick: 720 }),
    onTheLine: said(0, d, { tick: d }),
    oneTickPast: said(0, d, { tick: d + 1 }),
    w5bPlant1197: said(0, d, { tick: 1197 }),
    forfeitPlant1320: said(0, d, { tick: 1320 }),
    noMark: said(0, d, null),
  };
  console.log('  FACTS (first mark, omitted default):', JSON.stringify(facts));
  assert.deepEqual(facts, { defaultDeadline: 900, pageFirstMark60: null, afterOneInputWait720: null, onTheLine: null,
    oneTickPast: FORFEIT, w5bPlant1197: FORFEIT, forfeitPlant1320: FORFEIT, noMark: null });
});

test('the line is join tick + deadline, inclusive, and a late joiner counts from its own join', () => {
  assert.equal(said(0, 120, { tick: 120 }), null, 'a first mark exactly on the line was FORFEIT');
  assert.equal(said(0, 120, { tick: 121 }), FORFEIT, 'a first mark one tick past the line was not FORFEIT');
  assert.equal(said(500, 120, { tick: 560 }), null);
  assert.equal(said(500, 120, { tick: 621 }), FORFEIT);
  assert.equal(firstMarkOutcome({ joinTick: 500, deadlineTicks: 120, firstMark: { tick: 621 } }).lastTick, 620);
  assert.throws(() => said(0, 120, { tick: 60, previousHash: b32(7) }), /not the first mark/);
  assert.equal(said(0, 120, { tick: 60, previousHash: new Uint8Array(32) }), null);
  assert.throws(() => said(500, 120, { tick: 499 }), /at or after the join tick/);
  assert.throws(() => said(0, 0, { tick: 1 }), /at least 1/);
  assert.throws(() => said(-1, 120, null), /join tick/);
});

const contract = (extra = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x0a), b32(0x0b)], ...extra,
});

test('the round names its start deadline, or omits it and gets the named default; omitting it changes no existing round', () => {
  const plain = contract();
  const bytes = toHex(encodeRoundContract(plain));
  const facts = {
    omittedDecodes: startDeadlineOf(decodeRoundContract(encodeRoundContract(plain))),
    explicitDefaultIsTheSameRound: toHex(encodeRoundContract(contract({ startDeadlineTicks: START_DEADLINE_TICKS }))) === bytes,
    tight120RoundTrips: decodeRoundContract(encodeRoundContract(contract({ startDeadlineTicks: 120 }))).startDeadlineTicks,
    tight120IsAnotherRound: toHex(roundId(contract({ startDeadlineTicks: 120 }))) !== toHex(roundId(plain)),
    named1400IsAnotherRound: toHex(roundId(contract({ startDeadlineTicks: 1400 }))) !== toHex(roundId(plain)),
  };
  console.log('  FACTS (deadline field):', JSON.stringify(facts));
  assert.deepEqual(facts, { omittedDecodes: 900, explicitDefaultIsTheSameRound: true, tight120RoundTrips: 120,
    tight120IsAnotherRound: true, named1400IsAnotherRound: true });
  const withTail = (n) => { const b = encodeRoundContract(plain); const out = new Uint8Array(b.length + 4); out.set(b); new DataView(out.buffer).setUint32(b.length, n); return out; };
  assert.throws(() => decodeRoundContract(withTail(START_DEADLINE_TICKS)), /written by omitting it/);
  assert.throws(() => decodeRoundContract(withTail(0)), /outside 1/);
  assert.throws(() => encodeRoundContract(contract({ startDeadlineTicks: 9000 })), /below the round's 9000/);
  assert.throws(() => encodeRoundContract(contract({ startDeadlineTicks: 0 })), /from 1/);
});
