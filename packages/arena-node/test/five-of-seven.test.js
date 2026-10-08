// TWO FIRST MARKS ON A FIVE-OF-SEVEN COMMITTEE (M3.3-34, ruled 2026-09-13).
//
// The same ruling as 2 of 2: two different first marks signed by the entry's
// session key are §13B's portable proof, and they FORFEIT with no refund - no
// signed result made up, no agreed run that never happened. On a hold the stake
// does not come back to that player (0 msat); on a lock only the player's own
// expiry refund, never a committee refund; and a signer node down at the close or past
// the hold's expiry does not hand the stake back.
//
// SEVEN LIVE DAEMONS, each on its own store and port, each able to go down and
// come back. THE ORDER: signer nodes 4-6 down while the on-time first mark (60) reaches
// signer node 0, which forwards it to 1-3 (four receipts, one short of five); 4-6 back;
// a DIFFERENT on-time first mark (30) to signer node 4, which forwards it to 5 and 6
// (three receipts). Neither mark can reach five, and signer nodes 0-3 hold the pair.
import { testNow, skipTo } from './test-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD, GENESIS_HASH, LOSER, NEEDED, NET, NO_PREVIOUS, PAST, PLANTED_FIRST_MARK_DEADLINE, RANDOMNESS, SIGNED_RECEIPT_BYTES, STAKE, TEST_FEDERATION_ID, WINDOW, WINNER, answer, assumeAssigned, b32, batchId, checkpointId, contractFor, curve, dealHandout, decodePlayerResult, ed25519, encodeCheckpoint, encodeEntryContract, encodeHandout, encodeInputBatch, encodeRoundContract, entryFeeMsat, entryId, feldmanGroup, handoutId, init, joinAndPlay, joinSigned, joinWithTwoFirstMarks, lockAfterClose, lockFieldsToJson, lockPort, netStakeMsat, openStore, opts, outageCaughtUp, pathTwoSignerNodeFourDown, playWinner, rand, receiptsAt, recordsOf, refundKeyOf, refundNow, resultFinality, roundId, say, scalarFrom32, secretScalar, seedWordForEntry, serve, sevenSignerNodes, sha256, signedOutcomes, signerNodeHolds, splitSignedResult, stateAt, stateHash, step, toHex, tweakPoint, twoFirstMarks, voidAtZeroToFourCut, voidAtZeroToThree, wait, wordsAt,
} from './five-of-seven-fixture.js';
import { CLOCK } from './block-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';

test('5 of 7, a stake lock: two first marks - FORFEIT at all seven, no signer node signs the refund, no forfeit kept, the lock held (back only by the player\'s own expiry refund)', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });   // as its siblings: setup on a bonded chain takes longer
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const before = await twoFirstMarks(w, run);
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const closedAt = testNow() - endMs;
    await Promise.all(w.signerNodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    skipTo(endMs + 100);                                               // past the result window (WINDOW-10-SPEC)
    for (let t = Date.now(); Date.now() - t < 30000 && !w.signerNodes.every((d) => d.round.noQuorum(run.eid)); await wait(250));
    console.log('  TIMING (5 of 7, lock; ms after the result window\'s end block):', JSON.stringify({ closedAt, decidedAt: testNow() - endMs }));
    await wait(1000);
    const signerNodesAfter = stateAt(w, run);
    const doors = [];
    for (const d of w.signerNodes) doors.push((await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status);
    const facts = { before, signerNodes: signerNodesAfter, doors, forfeitKept: w.signerNodes.map((d) => (d.round.forfeit(run.eid) ? 1 : 0)),
      lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (5 of 7, lock):', JSON.stringify(facts));
    assert.deepEqual(facts.signerNodes, Array(7).fill('FORFEIT/0'), 'not FORFEIT with no signed result at every signer node');
    assert.deepEqual(facts.doors, Array(7).fill(409), 'a signer node signs the refund of the lock to the player');
    assert.deepEqual(facts.forfeitKept, Array(7).fill(0), 'a signer node keeps a refund of the lock');
    assert.equal(facts.lockHeld, true);
  } finally { await w.close(); }
});


test('5 of 7, a stake lock, path 1: signer nodes 0-3 record ENTRY_VOID on a real outage, then a different on-time first mark reaches signer node 4 - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a signer node keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} signer nodes would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});


test('5 of 7, a stake lock, path 2: signer nodes 0-3 record ENTRY_VOID, then a late first mark reaches signer node 4 alone and its forward is lost - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4);
    await w.down(0, 1, 2, 3);                                                   // signer node 4 alone: its forward goes nowhere
    const said4 = [];
    for (const m of run.late) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(1000);
    await w.back(0, 1, 2, 3, 5, 6);
    await wait(1000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, lateAt4: !!w.signerNodes[4].round.startForfeit(run.eid), voidAt4: !!w.signerNodes[4].round.entryVoid(run.eid),
      proofAt4: w.signerNodes[4].round.provenTwoFirstMarks(w.rid, run.eid), now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    // PICK A (ruled 2026-09-13): signer node 4, back, records the same ENTRY_VOID from the
    // full receipt set, so the player's late first mark reaching it is the second
    // first mark - refused as such and the pair kept - not a late start.
    assert.equal(facts.voidAt4, true, 'signer node 4 did not record the Void from the full receipts: not the case the test names');
    assert.ok(said4.some((a) => /FORFEIT: the player signed another first mark/.test(a)), `signer node 4 did not refuse the late mark as a second first mark: ${JSON.stringify(said4)}`);
    assert.equal(facts.proofAt4, true, 'signer node 4 kept no proof of two first marks');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a signer node keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} signer nodes would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});
