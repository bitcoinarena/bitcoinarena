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
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, EXPIRED, ACTING } from '../src/custody.js';
import * as custodyStates from '../src/custody.js';
import { DELIVERED, FORFEIT, VOID, netStakeMsat } from '../../protocol/src/payout.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contract = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
};
// THE PLAYER'S PREIMAGE, AND THE HASH THEY PUT ON THEIR OWN CONTRACT. 23.1:
// the stake commitment IS sha256 of a secret the player chose, which is why a
// node cannot settle a stake it has no shares for.
const preimageOf = (n) => b32(n + 60);
const entryFor = (rid, n) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: b32(n + 40),
  stakeCommitment: sha256(preimageOf(n)),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
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

// The committee's five shares, already reconstructed - standing in for a letter
// that has not been written, because what settling needs is the 32 bytes. Every
// player in this file is `b32(n)`, so their own preimage is `preimageOf(n)`.
const defaultPreimageFor = (entryId, entry) => preimageOf(entry.pubkey[0]);

function seated(port, { preimageFor = defaultPreimageFor } = {}) {
  const round = new Round(openStore(':memory:'), () => NOW + 1000);
  const rid = round.open(contract);
  const custody = new Custody(round, { port, preimageFor });
  return { round, rid, custody };
}


test('a daemon with no Lightning holds no stakes and says so', async () => {
  const { custody, rid } = seated(undefined);
  const held = await custody.hold(entryFor(rid, 1));
  assert.equal(held.ok, false);
  assert.match(held.why, /reaches no Lightning, so it holds no stakes/);

  const settled = await custody.settleHeldInvoices({ roundId: rid, entries: [] });
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
  assert.equal(row.amountMsat, netStakeMsat(entry), "the hold is not the net stake (22A)");
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
    ({ entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome, score, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat });

  const out = await custody.settleHeldInvoices({
    roundId: rid, minScore: 1,
    entries: [summary(winner, DELIVERED, 100), summary(loser, FORFEIT), summary(voided, VOID)],
    finalFor: () => true,
  });
  assert.equal(out.ok, true, out.why);

  const state = (e) => custody.stateOf(entryIdOf(e)).state;
  // AND THE INVOICE IS STILL THERE AFTERWARDS. A stake that moved and cannot
  // say which invoice it was is the thing 23 exists to prevent, and a state
  // change writes a row that knows nothing about the request.
  assert.match(custody.stateOf(entryIdOf(loser)).request, /^lnbcrt-/,
    'settling a stake erased the invoice it settled');
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
    ({ entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome, score, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat });

  // THE COMMITTEE HAS NOT AGREED. Not a refusal: the stakes simply stay in
  // flight, and a hold nobody may act on expires back to its payer.
  const out = await custody.settleHeldInvoices({
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

test('a stake whose hold already EXPIRED is not settled: a later close answers already moved and sends lnd nothing (M3.3-30)', async () => {
  // The 2 s share retry (M3.3-29) runs the close again while a lost stake is
  // HELD. Once the daemon's own chain has taken it past its HTLC's expiry the
  // row is EXPIRED, and the next close must leave it where it is: releasing a
  // preimage for an HTLC that expired settles nothing and says the wrong thing.
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }
  round.putHoldExpiry({ entryId: entryIdOf(loser), expiryHeight: 400 });
  const swept = custody.expire({ tipHeight: 401 });
  assert.deepEqual(swept.expired.map(toHex), [toHex(entryIdOf(loser))], 'the sweep did not expire the lost stake');
  assert.equal(custody.stateOf(entryIdOf(loser)).state, EXPIRED);

  const close = await custody.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
    ],
  });
  assert.equal(close.ok, true, close.why);
  const lost = close.actions.find((a) => toHex(a.entryId) === toHex(entryIdOf(loser)));
  assert.match(lost.why, /already moved/, `a close tried to act on an expired hold: ${lost.why}`);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, EXPIRED, 'the expired row was overwritten');
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 0, 'a preimage was released for an HTLC that had expired');
  assert.equal(custody.stateOf(entryIdOf(winner)).state, CANCELLED, 'the winner\'s own stake was not handed back');
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
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
    ],
  };

  await custody.settleHeldInvoices(once);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, SETTLED);

  // AND AGAIN. A settlement replayed - a restarted daemon, a committee message
  // arriving twice - must not release a second preimage or hand a stake back
  // twice: they moved once, and there is nothing left to move.
  const twice = await custody.settleHeldInvoices(once);
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

  const out = await custody.settleHeldInvoices({
    roundId: rid, minScore: 3, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(placed), pubkey: placed.playerPubkey, outcome: DELIVERED, score: 5, stakeMsat: placed.stakeMsat, feeMsat: placed.feeMsat, donationMsat: placed.donationMsat },
      { entryId: entryIdOf(cautious), pubkey: cautious.playerPubkey, outcome: DELIVERED, score: 1, stakeMsat: cautious.stakeMsat, feeMsat: cautious.feeMsat, donationMsat: cautious.donationMsat },
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
    ],
  });
  assert.equal(out.ok, true, out.why);

  const paid = (e) => out.table.table.find((r) => toHex(r.pubkey) === toHex(e.playerPubkey)).amountMsat;
  assert.equal(paid(placed), netStakeMsat(placed) + netStakeMsat(loser), 'the only qualifier did not take the whole pool');
  assert.equal(paid(cautious), 0n, 'a player below the score placed anyway');

  // AND BOTH DELIVERED STAKES COME BACK REGARDLESS. Placing nowhere is a legal
  // strategy, not a levy: only the forfeit moves.
  assert.equal(custody.stateOf(entryIdOf(placed)).state, CANCELLED);
  assert.equal(custody.stateOf(entryIdOf(cautious)).state, CANCELLED);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, SETTLED);
});

// A round with a forfeited stake and nobody to hand it to is one `payout.js`
// refuses outright, so every interrupted-act test below closes a real round:
// the loser first, so the settle is the act that gets interrupted, and a
// winner behind it whose cancel never happens.
async function midAct(port) {
  const { round, rid, custody } = seated(port);
  const loser = entryFor(rid, 2);
  const winner = entryFor(rid, 1);
  for (const e of [loser, winner]) { round.enter(e); await custody.hold(e); }
  const close = {
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
    ],
  };
  return { round, rid, custody, loser, winner, id: entryIdOf(loser), close };
}

// 9.4'S NAMES ON THE SEATS, NOT A STAND-IN. IMPLEMENTATION.md 9.4:
//
//   AWAITING_INVOICE -> HELD -> (result FINAL)
//     qualifying: CANCEL_REQUESTED -> CANCELLED -> ...
//     losing:     ... -> SETTLE_REQUESTED -> SETTLED
//
// Measured before this: the moment before an invoice exists was not written at
// all, and both acts were written as `ACTING`, a label of this file's own. The
// names are the spec's strings, so the tests say them literally.
test('every act is on disk under 9.4\'s name when the call is made - CANCEL_REQUESTED, SETTLE_REQUESTED - never the old stand-in', async () => {
  assert.equal(custodyStates.CANCEL_REQUESTED, 'CANCEL_REQUESTED');
  assert.equal(custodyStates.SETTLE_REQUESTED, 'SETTLE_REQUESTED');
  const port = fakePort();
  const { custody, loser, winner, close } = await midAct(port);
  const at = {};
  const settle = port.settle.bind(port);
  const cancel = port.cancel.bind(port);
  port.settle = async (a) => { at.settle = custody.stateOf(entryIdOf(loser)).state; return settle(a); };
  port.cancel = async (a) => { at.cancel = custody.stateOf(entryIdOf(winner)).state; return cancel(a); };

  const out = await custody.settleHeldInvoices(close);
  assert.equal(out.ok, true, out.why);
  assert.equal(at.cancel, 'CANCEL_REQUESTED', `a cancel was written as ${at.cancel}`);
  assert.equal(at.settle, 'SETTLE_REQUESTED', `a settle was written as ${at.settle}`);
  assert.notEqual(at.cancel, ACTING);
  assert.notEqual(at.settle, ACTING);
  assert.equal(custody.stateOf(entryIdOf(winner)).state, CANCELLED);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, SETTLED);
});

test('AWAITING_INVOICE is on disk before the invoice is asked for, and HELD once it is checked', async () => {
  assert.equal(custodyStates.AWAITING_INVOICE, 'AWAITING_INVOICE');
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const e = entryFor(rid, 1);
  round.enter(e);
  const eid = entryIdOf(e);
  let during = null;
  const create = port.createHeld.bind(port);
  port.createHeld = async (a) => { const r = round.hold(eid); during = r && r.state; return create(a); };

  const held = await custody.hold(e);
  assert.equal(held.ok, true, held.why);
  assert.equal(during, 'AWAITING_INVOICE', `when the invoice was asked for, the row was ${during}`);
  const row = round.hold(eid);
  assert.equal(row.state, HELD);
  assert.equal(toHex(row.paymentHash), toHex(e.stakeCommitment));
  assert.equal(row.amountMsat, netStakeMsat(e));
});

test('a node that died awaiting its invoice asks for it again and holds, rather than calling it held', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const e = entryFor(rid, 1);
  round.enter(e);
  const eid = entryIdOf(e);
  const create = port.createHeld.bind(port);
  port.createHeld = async () => { throw new Error('the node stopped here'); };
  await assert.rejects(() => custody.hold(e));
  assert.equal(round.hold(eid).state, 'AWAITING_INVOICE');
  assert.equal(round.hold(eid).request, null, 'an invoice was recorded that nobody issued');

  // A ROW WITH NO INVOICE IS NOT A HOLD: the next ask issues it (the endpoint
  // takes up one it already made - lnd-port.test.js), and nothing is acted on
  // in between.
  port.createHeld = create;
  const held = await custody.hold(e);
  assert.equal(held.ok, true, held.why);
  assert.equal(held.state, HELD);
  assert.match(held.invoice, /^lnbcrt-/);
  assert.equal(port.calls.filter((c) => c[0] === 'createHeld').length, 1);
});

test('a store written under the old ACTING label is still asked about, and resolved', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const e = entryFor(rid, 2);
  round.enter(e);
  const eid = entryIdOf(e);
  round.putHold({ entryId: eid, roundId: rid, paymentHash: e.stakeCommitment,
    amountMsat: netStakeMsat(e), state: 'ACTING', why: 'written before 9.4\'s names' });
  port.look = async () => ({ state: SETTLED });
  const asked = await custody.reconcile();
  assert.equal(asked.ok, true, asked.why);
  assert.deepEqual(asked.asked.map((a) => a.state), [SETTLED]);
  assert.equal(round.hold(eid).state, SETTLED);
});

test('the same close run twice moves every hold once - a rerun leaves a moved hold where it is', async () => {
  // M3.3-25 runs a round's close logic again when a run turns final after the
  // first close. That is only safe if a hold that already moved is left alone.
  const port = fakePort();
  const { custody, close } = await midAct(port);
  const first = await custody.settleHeldInvoices(close);
  assert.equal(first.ok, true, first.why);
  const acted = port.calls.filter((c) => c[0] === 'settle' || c[0] === 'cancel').length;
  assert.equal(acted, 2, 'the first close did not act on both holds');
  const again = await custody.settleHeldInvoices(close);
  assert.equal(again.ok, true, again.why);
  assert.equal(port.calls.filter((c) => c[0] === 'settle' || c[0] === 'cancel').length, acted,
    'a rerun of the close moved a hold a second time');
  assert.ok(again.actions.every((a) => /already moved/.test(a.why)), JSON.stringify(again.actions.map((a) => a.why)));
});

test('a node that died mid-act asks Lightning rather than acting again', async () => {
  // The window is one SIGKILL wide: Lightning has been told and this node has
  // not written it down. `custody-crash.mjs` kills a real process inside it;
  // what is measured here is what the two sides say afterwards.
  const port = fakePort();
  const { custody, id, close } = await midAct(port);

  // The settle reached Lightning and the answer never came back.
  port.settle = async ({ paymentHash }) => {
    port.calls.push(['settle', toHex(paymentHash)]);
    throw new Error('the node stopped here');
  };
  await assert.rejects(() => custody.settleHeldInvoices(close));
  assert.equal(custody.stateOf(id).state, 'SETTLE_REQUESTED',
    'the intent was not on disk before the call, so a restart cannot know it was made');
  assert.match(custody.stateOf(id).why, /ask Lightning/);

  // A CLOSE THAT RUNS AGAIN WILL NOT ACT ON IT. Not until somebody has asked.
  port.settle = async ({ paymentHash }) => { port.calls.push(['settle', toHex(paymentHash)]); };
  const blocked = await custody.settleHeldInvoices(close);
  assert.match(blocked.actions[0].why, /reconcile it against Lightning first/);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 1);

  // ASKED, AND ANSWERED. Lightning holds the preimage, so the stake moved.
  port.look = async ({ paymentHash }) => { port.calls.push(['look', toHex(paymentHash)]); return { state: SETTLED }; };
  const asked = await custody.reconcile({ roundId: close.roundId });
  assert.equal(asked.ok, true, asked.why);
  assert.deepEqual(asked.asked.map((a) => a.state), [SETTLED]);
  assert.equal(custody.stateOf(id).state, SETTLED);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 1,
    'the stake was settled a second time');
});

test('an act that never reached Lightning is made again, once', async () => {
  const port = fakePort();
  const { custody, id, close } = await midAct(port);

  port.settle = async () => { throw new Error('the node stopped before the call left'); };
  await assert.rejects(() => custody.settleHeldInvoices(close));

  // LIGHTNING STILL HOLDS IT, so the act never landed and the stake is HELD
  // again - not stuck, and not settled on a guess.
  port.look = async () => ({ state: HELD });
  port.settle = async ({ paymentHash }) => { port.calls.push(['settle', toHex(paymentHash)]); };
  await custody.reconcile({ roundId: close.roundId });
  assert.equal(custody.stateOf(id).state, HELD);

  await custody.settleHeldInvoices(close);
  assert.equal(custody.stateOf(id).state, SETTLED);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 1);
});

test('a port that cannot be asked what it did leaves an interrupted act alone', async () => {
  const port = fakePort();
  const { custody, id, close } = await midAct(port);

  port.settle = async () => { throw new Error('stopped'); };
  await assert.rejects(() => custody.settleHeldInvoices(close));

  const asked = await custody.reconcile({ roundId: close.roundId });
  assert.equal(asked.ok, false);
  assert.match(asked.why, /cannot be asked what it did/);
  assert.equal(custody.stateOf(id).state, 'SETTLE_REQUESTED', 'a guess was written down instead of an answer');
});

test('reconcile refuses an answer that is not a state a hold can be in', async () => {
  const port = fakePort();
  const { custody, id, close } = await midAct(port);

  port.settle = async () => { throw new Error('stopped'); };
  await assert.rejects(() => custody.settleHeldInvoices(close));

  port.look = async () => ({ state: 'PROBABLY FINE' });
  const asked = await custody.reconcile({ roundId: close.roundId });
  assert.equal(asked.ok, false);
  assert.match(asked.why, /not a state a hold can be in/);
  assert.equal(custody.stateOf(id).state, 'SETTLE_REQUESTED');
});

test('a node with no preimage cannot settle, and the stake expires to its player', async () => {
  // 23.4 asks for five of seven preimage shares before a stake moves. A node
  // that has none is not stuck: it settles nothing, the HTLC expires, and the
  // player is refunded - which is the same direction a crash points in.
  const port = fakePort();
  const { round, rid, custody } = seated(port, { preimageFor: null });
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }

  const out = await custody.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
    ],
  });
  assert.equal(out.ok, true, out.why);
  assert.match(out.actions[0].why, /no preimage for that stake/);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, HELD);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 0);

  // AND THE REFUND STILL HAPPENS. Not settling a loser is not a reason to keep
  // a winner's money in flight.
  assert.equal(custody.stateOf(entryIdOf(winner)).state, CANCELLED);
});

test('a preimage that is not the one the hold was made for is refused', async () => {
  const port = fakePort();
  const { round, rid, custody } = seated(port, { preimageFor: () => new Uint8Array(32).fill(0xab) });
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }

  const out = await custody.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
    ],
  });
  assert.match(out.actions[0].why, /not the one this hold was made for/);
  assert.equal(custody.stateOf(entryIdOf(loser)).state, HELD);
  assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 0);
});

test('the preimage reaches the port, because releasing it is the settlement', async () => {
  const port = fakePort();
  const seen = [];
  port.settle = async ({ paymentHash, preimage }) => {
    port.calls.push(['settle', toHex(paymentHash)]);
    seen.push(preimage);
  };
  const { round, rid, custody } = seated(port);
  const winner = entryFor(rid, 1);
  const loser = entryFor(rid, 2);
  for (const e of [winner, loser]) { round.enter(e); await custody.hold(e); }

  await custody.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: entryIdOf(loser), pubkey: loser.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: loser.stakeMsat, feeMsat: loser.feeMsat, donationMsat: loser.donationMsat },
      { entryId: entryIdOf(winner), pubkey: winner.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: winner.stakeMsat, feeMsat: winner.feeMsat, donationMsat: winner.donationMsat },
    ],
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(toHex(sha256(seen[0])), toHex(loser.stakeCommitment));
});

test('a round nobody finished moves no stake and keeps nothing for this node', async () => {
  // `payout.js` refuses to hand a pool to nobody rather than deciding it in
  // the operator's favour, and that refusal has to reach the wire as INACTION,
  // not as an exception somebody logs and steps past. Measured through the
  // daemon: until a player delivers, every round is one of these.
  const port = fakePort();
  const { round, rid, custody } = seated(port);
  const a = entryFor(rid, 1);
  const b = entryFor(rid, 2);
  for (const e of [a, b]) { round.enter(e); await custody.hold(e); }

  const out = await custody.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [a, b].map((e) => ({ entryId: entryIdOf(e), pubkey: e.playerPubkey,
      outcome: FORFEIT, score: 0, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat })),
  });
  assert.equal(out.ok, false);
  assert.match(out.why, /no stake moves/);
  assert.match(out.why, /expires to its player/);
  for (const e of [a, b]) assert.equal(custody.stateOf(entryIdOf(e)).state, HELD);
  assert.equal(port.calls.filter((c) => c[0] !== 'createHeld').length, 0,
    'a stake moved in a round that had nobody to pay');
});
