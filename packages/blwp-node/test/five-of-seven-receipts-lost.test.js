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
// THE RECEIPTS-LOST AND OUTAGE-VOID HALF of five-of-seven (split out to fit the 180 s per-file cap; same fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD, GENESIS_HASH, LOSER, NEEDED, NET, NO_PREVIOUS, PAST, PLANTED_FIRST_MARK_DEADLINE, RANDOMNESS, SIGNED_RECEIPT_BYTES, STAKE, TEST_FEDERATION_ID, WINDOW, WINNER, answer, assumeAssigned, b32, batchId, checkpointId, contractFor, curve, dealHandout, decodePlayerResult, ed25519, encodeCheckpoint, encodeEntryContract, encodeHandout, encodeInputBatch, encodeRoundContract, entryFeeMsat, entryId, feldmanGroup, handoutId, init, joinAndPlay, joinSigned, joinWithTwoFirstMarks, lockAfterClose, lockFieldsToJson, lockPort, netStakeMsat, openStore, opts, outageCaughtUp, pathTwoSignerNodeFourDown, playWinner, rand, receiptsAt, recordsOf, refundKeyOf, refundNow, resultFinality, roundId, say, scalarFrom32, secretScalar, seedWordForEntry, serve, sevenSignerNodes, sha256, signedOutcomes, signerNodeHolds, splitSignedResult, stateAt, stateHash, step, toHex, tweakPoint, twoFirstMarks, voidAtZeroToFourCut, voidAtZeroToThree, wait, wordsAt,
} from './five-of-seven-fixture.js';


test('5 of 7, a stake lock, receipts lost between signer nodes that are up: signer nodes 0-4 each record ENTRY_VOID, then a different on-time first mark reaches signer node 5 - measured: refund signatures, whether a committee refund forms, the lock', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost between up signer nodes):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx - five signatures formed');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});


// RECEIPTS LOST, AND THE SIGNER NODE HOLDING THE PROOF UNREACHABLE FROM THE VOID SIGNER NODES
// WHEN THE REFUND IS ASKED (M3.3-34, the variant left open by cb63823): the
// receipts-lost order, then signer nodes 0-4 and signer node 5 cut off from each other (signer node 6
// reaches all) while the lock refund is asked; healed after.
test('5 of 7, a stake lock, receipts lost, and signer node 5 (the proof) unreachable from the Void signer nodes when the refund is asked - measured: refund signatures, whether a committee refund forms', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run);
    w.partition([0, 1, 2, 3, 4], [5]);
    const now = await refundNow(w, run);
    const proofAtRefund = w.signerNodes.map((d) => (d.round.provenTwoFirstMarks(w.rid, run.eid) ? 1 : 0));
    w.heal();
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, proofAtRefund, now, closed, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost, signer node 5 unreachable at the refund):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.proof[5], 1, 'signer node 5 does not hold the proof: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx - five signatures formed');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});


// A GENUINE OUTAGE-VOID ON THE SAME TOPOLOGY (M3.3-34, the path Plan A must not
// break): receipts lost between signer nodes that are up, signer nodes 0-4 record ENTRY_VOID -
// and the player signs NO second first mark. No signer node holds a proof; the fast
// committee refund of the lock must still form.
test('5 of 7, a stake lock, receipts lost between signer nodes that are up, and no second first mark - a genuine outage-VOID: the fast committee refund still forms', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run, { second: false });
    const now = await refundNow(w, run);
    const facts = { ...setup, now, msatBackByCommittee: now.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost, a genuine outage-VOID):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(setup.proof, Array(7).fill(0), 'a signer node holds a proof of two first marks: not the case the test names');
    assert.ok(now.doors.some((s) => s === 200), `the genuine outage-VOID's fast refund did not form: ${JSON.stringify(now.doors)}`);
    assert.ok(now.kept > 0, 'no signer node keeps the refund of a genuine outage-VOID');
  } finally { await w.close(); }
});


test('5 of 7, a stake lock, genuine outage-VOID: signer nodes 4-6 down, then caught up late - measured: what each signer node records, the refund doors', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await outageCaughtUp(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signedOutcomes: signedOutcomes(w, run), signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, genuine outage-VOID, caught up late):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!facts.signedOutcomes.some((o) => o && /FAILED|DELIVERED/.test(o)), `a signer node signed a run for an entry that must VOID: ${JSON.stringify(facts.signedOutcomes)}`);
  } finally { await w.close(); }
});
