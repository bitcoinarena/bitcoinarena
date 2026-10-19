// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PATHS WITH SIGNER NODES DOWN THROUGH THE LOCK'S EXPIRY, split from five-of-seven.test.js (2026-09-24) so each file
// stays inside the suite's 180 s: every round now waits for its result window's end block on the chain.
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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD, GENESIS_HASH, LOSER, NEEDED, NET, NO_PREVIOUS, PAST, PLANTED_FIRST_MARK_DEADLINE, RANDOMNESS, SIGNED_RECEIPT_BYTES, STAKE, TEST_FEDERATION_ID, WINDOW, WINNER, answer, assumeAssigned, b32, batchId, checkpointId, contractFor, curve, dealHandout, decodePlayerResult, ed25519, encodeCheckpoint, encodeEntryContract, encodeHandout, encodeInputBatch, encodeRoundContract, entryFeeMsat, entryId, feldmanGroup, handoutId, init, joinAndPlay, joinSigned, joinWithTwoFirstMarks, lockAfterClose, lockFieldsToJson, lockPort, netStakeMsat, openStore, opts, outageCaughtUp, pathTwoSignerNodeFourDown, playWinner, rand, receiptsAt, recordsOf, refundKeyOf, refundNow, resultFinality, roundId, say, scalarFrom32, secretScalar, seedWordForEntry, serve, sevenSignerNodes, sha256, signedOutcomes, signerNodeHolds, splitSignedResult, stateAt, stateHash, step, toHex, tweakPoint, twoFirstMarks, voidAtZeroToFourCut, voidAtZeroToThree, wait, wordsAt,
} from './five-of-seven-fixture.js';
import { CLOCK } from './block-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';

test('5 of 7, a stake lock, path 1, signer nodes 4-6 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    await w.down(4, 5, 6);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, signerNodes: [0, 1, 2, 3].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, signer nodes 4-6 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});


test('5 of 7, a stake lock, path 1, signer nodes 3-5 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i));
    await w.down(3, 4, 5);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, beforeDown, now, closed, signerNodes: [0, 1, 2, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, signer nodes 3-5 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});


test('5 of 7, a stake lock, path 2, signer node 4 down from its refusal through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signerNodes: [0, 1, 2, 3, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2, signer node 4 down from its refusal):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.lateAt4, true, 'signer node 4 kept no late first mark: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});
