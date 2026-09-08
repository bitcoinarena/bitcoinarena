// A ROUND CANNOT OPEN ENTRIES BEFORE ITS COMMITTEE, OR START WITHOUT A WINDOW.
//
// 5A.5:
//
//   committee_time      beacon value appears -> committees selected & verified
//                       |  ENTRY WINDOW OPENS HERE
//   start_time          round begins for everyone committed so far
//
//   entry_open_time == committee_time
//   start_time      >= committee_time + min_entry_window   (reference: 60 s)
//
// And it is not a policy choice: 23.1 encrypts the preimage shares TO the
// settlement committee, so an entry cannot be CONSTRUCTED before the committee
// exists. "Selecting at start_time and allowing commitment before that is
// impossible, not merely unwise."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { roundWindowsAreValid, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const COMMITTEE_TIME = 500n;
const contract = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: COMMITTEE_TIME + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});
const session = ed25519.utils.randomSecretKey();
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0x5e),
});

test('a round that leaves no time to enter is refused, and the boundary itself lives', () => {
  // EXACTLY THE WINDOW IS ENOUGH. `>=` is the spec's own comparison, and one
  // millisecond either side of it is the whole difference between a round
  // anybody can join and one nobody can.
  const exact = contract({ startTimeMs: COMMITTEE_TIME + MIN_ENTRY_WINDOW_MS });
  assert.equal(roundWindowsAreValid(exact).ok, true, 'a round with exactly the window was refused');

  const short = contract({ startTimeMs: COMMITTEE_TIME + MIN_ENTRY_WINDOW_MS - 1n });
  assert.equal(short.ok, undefined);
  const seen = roundWindowsAreValid(short);
  assert.equal(seen.ok, false, 'a round one millisecond short was accepted');
  assert.match(seen.why, /leaving 59999ms to enter where this protocol asks for 60000/);

  // A ROUND THAT STARTS BEFORE ITS COMMITTEE EXISTS is the same rule at its
  // extreme, and it used to be the shape of every fixture in this tree.
  const before = roundWindowsAreValid(contract({ startTimeMs: COMMITTEE_TIME - 1n }));
  assert.equal(before.ok, false);
  assert.match(before.why, /leaving -1ms to enter/);

  // AND ENTRY CANNOT CLOSE BEFORE IT OPENS.
  const backwards = roundWindowsAreValid(contract({ entryCloseMs: COMMITTEE_TIME - 1n }));
  assert.equal(backwards.ok, false);
  assert.match(backwards.why, /closes entry at 499, before its committee forms at 500/);

  // and a round naming no committee time has no window at all
  assert.match(roundWindowsAreValid(contract({ committeeTimeMs: undefined })).why,
    /names no committee time/);
});

test('a node refuses to store a round nobody could join', () => {
  const round = new Round(openStore(), () => 600);
  assert.throws(() => round.open(contract({ startTimeMs: COMMITTEE_TIME + 1n })),
    /leaving 1ms to enter where this protocol asks for 60000/,
    'a round nobody can join was stored');

  // and the same contract with the window is stored
  const ok = contract();
  assert.deepEqual(round.open(ok), roundId(ok));
});

test('entry opens at committee_time and not one millisecond before', () => {
  const c = contract();
  const rid = roundId(c);

  // BEFORE: refused by name. The lobby shows "committee: pending" and offers
  // no entry button - this is the same rule at the door, where a client that
  // draws no lobby cannot skip it.
  for (const now of [0, 1, Number(COMMITTEE_TIME) - 1]) {
    const early = new Round(openStore(), () => now);
    early.open(c);
    assert.throws(() => early.enter(entryFor(rid)),
      new RegExp(`committee forms at 500 and it is ${now}: entry opens then`),
      `an entry at ${now} was taken before the committee existed`);
  }

  // AT COMMITTEE_TIME: open. The equality is the spec's - entry_open_time ==
  // committee_time - so the instant itself is inside the window, not outside.
  const at = new Round(openStore(), () => Number(COMMITTEE_TIME));
  at.open(c);
  assert.ok(at.enter(entryFor(rid)), 'the committee formed and entry was still refused');

  // AND AFTER, for as long as the round is open.
  const later = new Round(openStore(), () => Number(COMMITTEE_TIME) + 10000);
  later.open(c);
  assert.ok(later.enter(entryFor(rid)));
});
