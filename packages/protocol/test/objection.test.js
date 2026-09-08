// THE OBJECTION WINDOW, SECTION 13A.
//
// "After a result is PROVISIONALLY_FINAL, the window W (reference: 10 minutes,
// contract-defined) runs... It becomes FINAL when the window closes without a
// valid objection." And: "a valid objection suspends finality. The full
// committee re-runs the canonical transcript... If the committee cannot reach
// 5-of-7 on the re-run, 13C applies."
//
// WHO MAY OBJECT IS ANYONE - "the affected player, another player in the
// round, a non-selected node, a spectator, a watchtower" - so nothing here
// gates on who signed the objection. The set comparison is on the RECEIPTS it
// carries, which must be the committee's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeObjection, decodeObjection, objectionId, objectionHolds, finality,
  PROVISIONALLY_FINAL, FINAL, SUSPENDED,
} from '../src/objection.js';
import { resultId, RESULTS_FOR_FINAL } from '../src/result.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { OBJECTION_WINDOW_REFERENCE_MS } from '../src/constants.js';
import { encodeRoundContract, decodeRoundContract } from '../src/contracts.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const committee = [1, 2, 3, 4, 5, 6, 7].map(b32);

const contract = (over = {}) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: OBJECTION_WINDOW_REFERENCE_MS, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: committee, ...over,
});

const result = (over = {}) => ({
  roundId: b32(1), playerPubkey: b32(2), outcome: DELIVERED, score: 1200,
  transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: b32(1), ...over,
});
const signedBy = (n) => Array.from({ length: n }, (_, i) =>
  ({ resultId: resultId(result()), nodePubkey: committee[i] }));

const objection = (over = {}) => ({
  roundId: b32(1), playerPubkey: b32(2), transcriptHash: b32(3),
  signedResultId: resultId(result()), claimedOutcome: FAILED, claimedScore: 0,
  // inside the window the tests open at 10000: an objection dated before the
  // result was even provisional is not one the window ever ran for
  objectorPubkey: b32(0x9e), atMs: 10001n, ...over,
});
const committeeReceipts = () => [1, 2, 3, 4, 5].map((n) => ({ nodePubkey: committee[n - 1] }));

/** An objection is always checked AGAINST a round and a result; these are it. */
const about = { roundId: b32(1), signedResultId: resultId(result()) };

test('the window is a field of the round the player signed, not a constant', () => {
  const c = contract();
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(back.objectionWindowMs, OBJECTION_WINDOW_REFERENCE_MS);
  assert.equal(OBJECTION_WINDOW_REFERENCE_MS, 600000n, 'ten minutes in milliseconds');

  // and it is covered by the contract's id: a shorter window is another round
  const shorter = contract({ objectionWindowMs: 1000n });
  assert.notEqual(toHex(encodeRoundContract(shorter)), toHex(encodeRoundContract(c)));
  assert.equal(decodeRoundContract(encodeRoundContract(shorter)).objectionWindowMs, 1000n);
});

test('an objection survives the wire, and every field is in its id', () => {
  const o = objection();
  assert.deepEqual(decodeObjection(encodeObjection(o)), o);
  assert.equal(objectionId(o).length, 32);
  for (const over of [
    { roundId: b32(9) }, { playerPubkey: b32(9) }, { transcriptHash: b32(9) },
    { signedResultId: b32(9) }, { claimedOutcome: DELIVERED }, { claimedScore: 7 },
    { objectorPubkey: b32(9) }, { atMs: 10002n },
  ]) {
    assert.notEqual(toHex(objectionId(objection(over))), toHex(objectionId(o)),
      JSON.stringify(Object.keys(over)));
  }
});

test('five committee signatures inside the window are provisional, not final', () => {
  const c = contract();
  const at = 10000n;
  const seen = finality({
    signedBy: signedBy(RESULTS_FOR_FINAL), committee, contract: c,
    provisionalAtMs: at, now: at + 1n,
  });
  assert.equal(seen.state, PROVISIONALLY_FINAL);
  assert.notEqual(seen.state, FINAL);
  assert.equal(seen.signers, 5);
  assert.equal(seen.closesAtMs, at + OBJECTION_WINDOW_REFERENCE_MS);

  // four is not even provisional: the window never opens
  const four = finality({
    signedBy: signedBy(4), committee, contract: c, provisionalAtMs: at, now: at + 1n,
  });
  assert.equal(four.state, null);
  assert.match(four.why, /4 of 5 on the strongest result/);
});

test('the window closes at the contract s length, to the millisecond', () => {
  const c = contract();
  const at = 10000n;
  const closes = at + OBJECTION_WINDOW_REFERENCE_MS;
  const ask = (now) => finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at, now,
  }).state;

  assert.equal(ask(closes - 1n), PROVISIONALLY_FINAL, 'one millisecond early was final');
  assert.equal(ask(closes), FINAL);
  assert.equal(ask(closes + 1n), FINAL);

  // a shorter window in the contract closes sooner - the number is not in the code
  const brief = contract({ objectionWindowMs: 1000n });
  const askBrief = (now) => finality({
    signedBy: signedBy(5), committee, contract: brief, provisionalAtMs: at, now,
  }).state;
  assert.equal(askBrief(at + 999n), PROVISIONALLY_FINAL);
  assert.equal(askBrief(at + 1000n), FINAL);

  // and a contract with no window at all is refused rather than guessed
  const { objectionWindowMs, ...noWindow } = c;
  const said = finality({
    signedBy: signedBy(5), committee, contract: noWindow, provisionalAtMs: at, now: closes,
  });
  assert.equal(said.state, null);
  assert.match(said.why, /does not say how long the objection window is/);
});

/**
 * THE MEMBERSHIP CHECK IS ON THE RECEIPTS, NOT ON THE OBJECTOR. Anyone may
 * object; what has to be the committee's is the evidence.
 */
test('a strangers receipt set makes the objection invalid, whoever sent it', () => {
  const strangers = [91, 92, 93].map((n) => ({ nodePubkey: b32(n) }));
  const no = objectionHolds({
    objection: objection(), receipts: strangers, committee, replayDiffers: true, ...about,
  });
  assert.equal(no.holds, false);
  assert.match(no.why, /is not from this round's committee/);

  // the same objection with the committee's receipts holds - and the objector
  // is a stranger in both, because anyone may object
  const yes = objectionHolds({
    objection: objection(), receipts: committeeReceipts(), committee, replayDiffers: true,
    ...about,
  });
  assert.equal(yes.holds, true);

  // a watchtower, a spectator, another player: none of them is gated
  for (const who of [b32(0x77), b32(0x88), b32(0x02)]) {
    assert.equal(objectionHolds({
      objection: objection({ objectorPubkey: who }), receipts: committeeReceipts(),
      committee, replayDiffers: true, ...about,
    }).holds, true, toHex(who));
  }

  // no replay, no objection: a claim is not a contradiction
  const unreplayed = objectionHolds({
    objection: objection(), receipts: committeeReceipts(), committee, ...about,
  });
  assert.equal(unreplayed.holds, false);
  assert.match(unreplayed.why, /no replay has contradicted the signed result/);

  // receipts for another transcript than the one the objection names
  const elsewhere = objectionHolds({
    objection: objection(), receipts: committeeReceipts(), committee,
    transcriptHash: b32(9), replayDiffers: true, ...about,
  });
  assert.equal(elsewhere.holds, false);
  assert.match(elsewhere.why, /a different transcript/);

  assert.equal(objectionHolds({ objection: objection(), receipts: [], committee, replayDiffers: true, ...about }).holds, false);
  assert.equal(objectionHolds({ objection: objection(), receipts: committeeReceipts(), committee: [], replayDiffers: true, ...about }).holds, false);
});

/**
 * AND WHAT A VALID ONE DOES. It suspends; it does not void. 13C's
 * FORFEIT-or-VOID is what happens if the committee's re-run cannot reach five
 * of seven, and that is named rather than done here.
 */
test('a valid objection inside the window suspends finality, and does not void it', () => {
  const c = contract();
  const at = 10000n;
  const holds = objectionHolds({
    objection: objection(), receipts: committeeReceipts(), committee, replayDiffers: true,
    ...about,
  });
  assert.equal(holds.holds, true);

  const seen = finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: at + 1n, objections: [holds],
  });
  assert.equal(seen.state, SUSPENDED);
  assert.notEqual(seen.state, FINAL);
  assert.match(seen.why, /the committee re-runs the canonical transcript/);
  assert.match(seen.why, /13C applies only if that re-run cannot reach five of seven/);
  assert.doesNotMatch(seen.why, /VOID/);

  // an objection that does not hold changes nothing
  const idle = objectionHolds({
    objection: objection(), receipts: committeeReceipts(), committee, replayDiffers: false,
    ...about,
  });
  assert.equal(finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: at + 1n, objections: [idle],
  }).state, PROVISIONALLY_FINAL);
});

/**
 * A LATE OBJECTION LEAVES A FINAL RESULT FINAL.
 *
 * Measured before this was checked: an objection dated 999999 ms past the
 * close held, and `finality` answered SUSPENDED - because it looked for a
 * holding objection before it looked at the clock. Section 13A opens the
 * window AFTER PROVISIONALLY_FINAL, and section 14 is blunt about the other
 * end: "once a player's result is FINAL, later infrastructure failure does not
 * erase it". Anyone able to produce one valid objection could otherwise
 * un-finalise a settled round at any time.
 */
test('an objection after the window closes cannot reopen a final result', () => {
  const c = contract();
  const at = 10000n;
  const closes = at + OBJECTION_WINDOW_REFERENCE_MS;

  const late = objectionHolds({
    objection: objection({ atMs: closes + 999999n }),
    receipts: committeeReceipts(), committee, replayDiffers: true, ...about,
  });
  assert.equal(late.holds, true, 'the objection itself is sound - it is only late');
  assert.equal(late.atMs, closes + 999999n);

  const seen = finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: closes + 999999n, objections: [late],
  });
  assert.equal(seen.state, FINAL, 'a late objection un-finalised a settled round');
  assert.equal(seen.late, 1);
  assert.match(seen.why, /came too late to reopen it/);

  // one millisecond inside the close still suspends, so the boundary is the
  // window and not the wording
  const justInTime = objectionHolds({
    objection: objection({ atMs: closes - 1n }),
    receipts: committeeReceipts(), committee, replayDiffers: true, ...about,
  });
  assert.equal(finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: closes + 999999n, objections: [justInTime],
  }).state, SUSPENDED, 'an objection raised inside the window stopped counting');

  // AT THE CLOSING MILLISECOND IT IS ALREADY SHUT, the same boundary the state
  // uses: `now === closesAtMs` is FINAL, so an objection dated there is late.
  const onTheDot = objectionHolds({
    objection: objection({ atMs: closes }),
    receipts: committeeReceipts(), committee, replayDiffers: true, ...about,
  });
  const atClose = finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: closes, objections: [onTheDot],
  });
  assert.equal(atClose.state, FINAL, 'an objection at the closing millisecond reopened it');
  assert.equal(atClose.late, 1);

  // and one dated before the result was provisional at all
  const early = objectionHolds({
    objection: objection({ atMs: at - 1n }),
    receipts: committeeReceipts(), committee, replayDiffers: true, ...about,
  });
  assert.equal(finality({
    signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
    now: at + 1n, objections: [early],
  }).state, PROVISIONALLY_FINAL);
});

/**
 * AN OBJECTION IS ABOUT ONE RESULT OF ONE ROUND.
 *
 * Measured before this was checked: an objection naming another round entirely
 * held, and suspended this one. Every check that existed passed - the receipts
 * were the committee's and the replay differed - they were simply checks about
 * a different round.
 */
test('an objection about another round, or another result, does not touch this one', () => {
  const c = contract();
  const at = 10000n;
  const good = { receipts: committeeReceipts(), committee, replayDiffers: true };

  const elsewhere = objectionHolds({
    objection: objection({ roundId: b32(0x77), signedResultId: b32(0x77) }), ...good, ...about,
  });
  assert.equal(elsewhere.holds, false);
  assert.match(elsewhere.why, /is about round 7777/);

  const otherResult = objectionHolds({
    objection: objection({ signedResultId: b32(0x55) }), ...good, ...about,
  });
  assert.equal(otherResult.holds, false);
  assert.match(otherResult.why, /is about result 5555/);

  // neither suspends anything
  for (const held of [elsewhere, otherResult]) {
    assert.equal(finality({
      signedBy: signedBy(5), committee, contract: c, provisionalAtMs: at,
      now: at + 1n, objections: [held],
    }).state, PROVISIONALLY_FINAL);
  }

  // and a caller that does not say which result is being objected to is
  // refused rather than assumed
  assert.equal(objectionHolds({ objection: objection(), ...good }).holds, false);
  assert.match(objectionHolds({ objection: objection(), ...good }).why,
    /no round and result to check this objection against/);
  assert.equal(objectionHolds({ objection: objection(), ...good, roundId: b32(1) }).holds, false);
});
