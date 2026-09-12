// ENTRY_VOID (§16) AS A PREDICATE, before any node wiring: the player's first
// mark tick against join tick + the round's start deadline. A mark in time is
// not Void; a first mark after the line is; no mark at all is not (§15's hole).
//
// The numbers are the ones measured on the node (tools/entry-void-before.mjs):
// join tick 0, first mark at tick 60, the run's next mark at 1320 - the
// fixtures elsewhere whose single first mark is at 1320 (forfeit.test.js) or
// 1197 (the W5b rehearsal) - and on the built page (lobby-regtest.sh): first
// mark at tick 60, and 720 after one timed-out 10 s input wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entryVoidOutcome, startDeadlineOf } from '../src/entry-void.js';
import { START_DEADLINE_TICKS } from '../src/constants.js';
import { ENTRY_VOID } from '../src/payout.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../src/constants.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const said = (joinTick, deadlineTicks, firstMark) => entryVoidOutcome({ joinTick, deadlineTicks, firstMark }).outcome;

test('the three measured cases, on a round that names the tight line of 120: in time is not Void, after it is, no mark is not', () => {
  const facts = {
    markAt60: said(0, 120, { tick: 60 }),
    markAt1320: said(0, 120, { tick: 1320 }),
    markAt1197: said(0, 120, { tick: 1197 }),
    noMark: said(0, 120, null),
  };
  console.log('  FACTS (ENTRY_VOID predicates, deadline 120):', JSON.stringify(facts));
  assert.deepEqual(facts, { markAt60: null, markAt1320: ENTRY_VOID, markAt1197: ENTRY_VOID, noMark: null });
  assert.match(entryVoidOutcome({ joinTick: 0, deadlineTicks: 120, firstMark: null }).why, /not ENTRY_VOID.*§15/);
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
  console.log('  FACTS (ENTRY_VOID predicates, omitted default):', JSON.stringify(facts));
  assert.deepEqual(facts, { defaultDeadline: 900, pageFirstMark60: null, afterOneInputWait720: null, onTheLine: null,
    oneTickPast: ENTRY_VOID, w5bPlant1197: ENTRY_VOID, forfeitPlant1320: ENTRY_VOID, noMark: null });
});

test('the line is join tick + deadline, inclusive, and a late joiner counts from its own join', () => {
  assert.equal(said(0, 120, { tick: 120 }), null, 'a first mark exactly on the line was Void');
  assert.equal(said(0, 120, { tick: 121 }), ENTRY_VOID, 'a first mark one tick past the line was not Void');
  assert.equal(said(500, 120, { tick: 560 }), null);
  assert.equal(said(500, 120, { tick: 621 }), ENTRY_VOID);
  assert.equal(entryVoidOutcome({ joinTick: 500, deadlineTicks: 120, firstMark: { tick: 621 } }).lastTick, 620);
  // A MARK THAT CHAINS TO ANOTHER IS NOT A FIRST MARK, and a mark before the join is nothing.
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
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 9000,
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
  // ONE ENCODING PER ROUND: the default written out, zero, or a deadline past the run is refused.
  const withTail = (n) => { const b = encodeRoundContract(plain); const out = new Uint8Array(b.length + 4); out.set(b); new DataView(out.buffer).setUint32(b.length, n); return out; };
  assert.throws(() => decodeRoundContract(withTail(START_DEADLINE_TICKS)), /written by omitting it/);
  assert.throws(() => decodeRoundContract(withTail(0)), /outside 1/);
  assert.throws(() => encodeRoundContract(contract({ startDeadlineTicks: 9000 })), /below the round's 9000/);
  assert.throws(() => encodeRoundContract(contract({ startDeadlineTicks: 0 })), /from 1/);
});
