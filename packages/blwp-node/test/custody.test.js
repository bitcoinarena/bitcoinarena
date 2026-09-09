// THE STAKE, FROM IN FLIGHT TO WHERE IT ENDS UP.
//
// 23.1 puts the player's money in a hold invoice and 23.2 says what each
// outcome does with it. Both were written in `payout.js` and, measured before
// this file existed, had ZERO callers outside their own tests. This is the
// caller, and the port it reaches is injected the way `sign`, the curve and the
// chain view are - so the rules are measured here with no Lightning node at
// all, and the real one is a tool.
//
// SINGLE-NODE CUSTODY, NOT §23.5: one Lightning node behind two daemons. What
// is measured is the state machine, not a threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, EXPIRED } from '../src/custody.js';
import { DELIVERED, FORFEIT, VOID } from '../../protocol/src/payout.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contract = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
};
const entryFor = (rid, n) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: b32(n + 40), stakeCommitment: b32(n + 60),
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
});

/** A Lightning node that keeps a log and no money. */
function fakePort({ hash, amount } = {}) {
  const calls = [];
  return {
    calls,
    async createHeld({ paymentHash, amountMsat, entryId }) {
      calls.push(['createHeld', toHex(paymentHash), amountMsat]);
      return {
        paymentHash: hash || paymentHash,
        amountMsat: amount === undefined ? amountMsat : amount,
        request: 'lnbcrt-' + toHex(entryId).slice(0, 8),
      };
    },
    async settle({ paymentHash }) { calls.push(['settle', toHex(paymentHash)]); },
    async cancel({ paymentHash }) { calls.push(['cancel', toHex(paymentHash)]); },
  };
}

function seated(port) {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);
  const rid = round.open(contract);
  const custody = new Custody(round, { port });
  return { round, rid, custody };
}

test('a daemon with no Lightning holds no stakes and says so', async () => {
  const { custody, rid } = seated(undefined);
  const held = await custody.hold(entryFor(rid, 1));
  assert.equal(held.ok, false);
  assert.match(held.why, /reaches no Lightning, so it holds no stakes/);

  const settled = await custody.settleRound({ roundId: rid, entries: [] });
  assert.equal(settled.ok, false);
  assert.match(settled.why, /settles nothing/);
});

test('the hold is issued against the entry\'s own signed numbers, once', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const entry = entryFor(rid, 1);
  round.enter(entry);

  const first = await custody.hold(entry);
  assert.equal(first.ok, true, first.why);
  assert.equal(first.state, HELD);
  assert.deepEqual(first.paymentHash, entry.stakeCommitment,
    'the hash is the one the player signed, not one the node chose');

  const row = custody.stateOf(entryIdOf(entry));
  assert.equal(row.state, HELD);
  assert.equal(row.amountMsat, entry.stakeMsat);
  assert.match(row.why, /in nobody's balance/);

  // ASKED TWICE IS HELD ONCE. A second invoice for one entry is a second claim
  // on one stake.
  const again = await custody.hold(entry);
  assert.equal(again.already, true);
  assert.equal(port.calls.filter((c) => c[0] === 'createHeld').length, 1);
});

test('an invoice that is not the entry\'s is refused, and nothing is stored', async () => {
  for (const [what, port] of [
    ['a different hash', fakePort({ hash: b32(0xee) })],
    ['a different amount', fakePort({ amount: 999n })],
  ]) {
    const { round, rid, custody } = seated(port);
    const entry = entryFor(rid, 1);
    round.enter(entry);
    const held = await custody.hold(entry);
    assert.equal(held.ok, false, `${what} was accepted`);
    assert.match(held.why, /the invoice does not match the entry/);
    assert.equal(custody.stateOf(entryIdOf(entry)), null, `${what} left a row behind`);
  }
});

test('DELIVERED cancels, FORFEIT settles, and a VOID is never touched', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);

  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  const voided = entryFor(rid, 3);
  for (const e of [winner, loser, voided]) { round.enter(e); await custody.hold(e); }

  const summary = (e, outcome, score = 0) =>
    ({ entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome, score, stakeMsat: e.stakeMsat });

  const out = await custody.settleRound({
    roundId: rid, minScore: 1,
    entries: [summary(winner, DELIVERED, 100), summary(loser, FORFEIT), summary(voided, VOID)],
    finalFor: () => true,
  });
  assert.equal(out.ok, true, out.why);

  const state = (e) => custody.stateOf(entryIdOf(e)).state;
  assert.equal(state(winner), CANCELLED, 'a delivered player did not get their stake back');
  assert.equal(state(loser), SETTLED, 'a forfeited stake did not enter the pool');
  assert.equal(state(voided), EXPIRED, 'a VOID was acted on');

  // AND THE VOID REACHED NO LIGHTNING AT ALL. 23.2: it expires, and a cancel
  // is an act an operator could withhold.
  const touched = port.calls.filter((c) => c[0] !== 'createHeld').map((c) => c[1]);
  assert.equal(touched.includes(toHex(voided.stakeCommitment)), false,
    'the node acted on a stake that only had to be left alone');
  assert.deepEqual(port.calls.filter((c) => c[0] === 'settle').map((c) => c[1]),
    [toHex(loser.stakeCommitment)]);
  assert.deepEqual(port.calls.filter((c) => c[0] === 'cancel').map((c) => c[1]),
    [toHex(winner.stakeCommitment)]);
});

test('no stake moves without a final result, and nothing is paid to anybody', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }

  const summary = (e, outcome, score = 0) =>
    ({ entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome, score, stakeMsat: e.stakeMsat });

  // THE COMMITTEE HAS NOT AGREED. Not a refusal: the stakes simply stay in
  // flight, and a hold nobody may act on expires back to its payer.
  const out = await custody.settleRound({
    roundId: rid, minScore: 1,
    entries: [summary(winner, DELIVERED, 100), summary(loser, FORFEIT)],
    finalFor: () => false,
  });
  assert.equal(out.ok, true, out.why);
  assert.equal(custody.stateOf(entryIdOf(winner)).state, HELD);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, HELD);
  assert.equal(port.calls.filter((c) => c[0] !== 'createHeld').length, 0,
    'a stake moved before the committee had finished');
  for (const a of out.actions) assert.match(a.why, /in flight|expires/);
});

test('a stake that has already moved is not moved twice', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }

  const once = {
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat },
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat },
    ],
  };

  await custody.settleRound(once);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, SETTLED);

  // AND AGAIN. A settlement replayed - a restarted daemon, a committee message
  // arriving twice - must not release a second preimage or hand a stake back
  // twice: they moved once, and there is nothing left to move.
  const twice = await custody.settleRound(once);
  assert.equal(twice.ok, true, twice.why);
  for (const a of twice.actions) assert.match(a.why, /already moved/);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 1);
  assert.equal(port.calls.filter((c) => c[0] === 'cancel').length, 1);
});

test('the score the round asked for is the score the pool pays by', async () => {
  // Three players, one pool of exactly one forfeited stake, and a minimum
  // score that only the first delivered player clears. If custody dropped
  // `minScore` on the way into 23.2's table, the cautious player would place
  // as well and the pool would be split two ways.
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const placed = entryFor(rid, 1);
  const cautious = entryFor(rid, 2);
  const loser = entryFor(rid, 3);
  for (const e of [placed, cautious, loser]) { round.enter(e); await custody.hold(e); }

  const out = await custody.settleRound({
    roundId: rid, minScore: 3, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(placed), pubkey: placed.playerPubkey, outcome: DELIVERED, score: 5, stakeMsat: placed.stakeMsat },
      { entryId: entryIdOf(cautious), pubkey: cautious.playerPubkey, outcome: DELIVERED, score: 1, stakeMsat: cautious.stakeMsat },
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat },
    ],
  });
  assert.equal(out.ok, true, out.why);

  const paid = (e) => out.table.table.find((r) => toHex(r.pubkey) === toHex(e.playerPubkey)).amountMsat;
  assert.equal(paid(placed), placed.stakeMsat + loser.stakeMsat, 'the only qualifier did not take the whole pool');
  assert.equal(paid(cautious), 0n, 'a player below the score placed anyway');

  // AND BOTH DELIVERED STAKES COME BACK REGARDLESS. Placing nowhere is a legal
  // strategy, not a levy: only the forfeit moves.
  assert.equal(custody.stateOf(entryIdOf(placed)).state, CANCELLED);
  assert.equal(custody.stateOf(entryIdOf(cautious)).state, CANCELLED);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, SETTLED);
});
