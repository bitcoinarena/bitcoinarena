// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LATE START AT THE CLOSE WITH TWO FIRST MARKS (5b-5e), AND §13C'S EVIDENCE TIED TO ITS BLOCK - split from
// first-mark.test.js (2026-09-24) so each file stays inside the suite's 180 s. The fixture is first-mark-fixture.js.
import { testNow, skipTo } from './test-clock.js';
import { test } from 'node:test';
import {
  CLOCK, END, FIELD, GENESIS_HASH, NO_PREVIOUS, RANDOMNESS, SIGNED_FORFEIT_0, STAKE, START_DEADLINE_TICKS, TEST_FEDERATION_ID, WINDOW_MS, WINNER, answer, assert, assumeAssigned, b32, batchId, brief, checkpointId, closeAndSettle, closingOf, contractFor, curve, dealHandout, decidedBoth, decodePlayerResult, ed25519, encodeCheckpoint, encodeEntryContract, encodeHandout, encodeInputBatch, encodeRoundContract, entryFeeMsat, entryId, feldmanGroup, finalAtBoth, handoutId, holdsFirst, init, joinAndBuild, joinSigned, lockFieldsToJson, lockHeldOf, lockPort, netStakeMsat, openStore, opts, outcomeAt, pastResultWindow, presentDay, rand, refundKeyOf, resultFinality, roundEndMs, roundId, say, scalarFrom32, secretScalar, seedWordForEntry, serve, sha256, signedAt, signerNodes, splitSignedResult, stateHash, step, toHex, transcriptsAcross, tweakPoint, untilForwarded, wait, wordsAt,
} from './first-mark-fixture.js';

// TWO FIRST MARKS ARE THE PLAYER'S EQUIVOCATION (§13B), NOT AN OUTAGE (M3, the
// guard case's leftover): an on-time first mark to B while A was down, and a
// late one to A. The player signed two chains from one parent, so the entry is
// FORFEIT - never ENTRY_VOID, which would refund a stake the player chose to
// split (§13C: "a player cannot manufacture a refund").
test('late start at close (5b): an on-time first mark at B and a late one at A, both signer nodes up at the close - FORFEIT, never ENTRY_VOID or a refund', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w);
    await w.downA();
    for (const m of run.messages.slice(0, 2)) await say(w.b.port, m);      // on time, to B only (A down)
    await w.upA();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A
    await wait(1000);
    const before = { bOnTime: holdsFirst(w.b, run), aLate: !!w.a.round.startForfeit(run.eid), bLate: !!w.b.round.startForfeit(run.eid),
      offersAtB: w.b.round.firstMarkOffers(run.eid) };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await pastResultWindow(w, () => [w.a, w.b].every((d) => d.round.noQuorum(run.eid) || d.round.results(w.rid, run.eid).length));
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit };
    };
    const after = { a: await at2(w.a), b: await at2(w.b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 5b, two first marks):', JSON.stringify({ before, after }));
    assert.equal(before.bOnTime, true, 'B does not hold the on-time first mark: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].entryVoid, false, `${s} recorded ENTRY_VOID: a refund for the player's own two first marks`);
      assert.notEqual(after[s].forfeit, 200, `${s} forfeited the lock to the player`);
      assert.ok(after[s].results.includes('FORFEIT/0') || after[s].noQuorum === 'FORFEIT', `${s} did not reach FORFEIT: ${JSON.stringify(after[s])}`);
    }
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// THE OTHER ORDER (5b's NOT COVERED): B decides its outage BEFORE the late first
// mark reaches it - the player's chain passes the line at B while A is down, so
// B records ENTRY_VOID - and only then does the player send A a late first mark.
// RULED (2026-09-12): two first marks are FORFEIT at both signer nodes, never a refund,
// even after a real outage-Void; B's Void stays as history, B signs no refund.
// MEASURED BEFORE: A 409 when asked first, then B's forfeit showed A the Void,
// A recorded it, and B's door answered 200 - a refund signed 2 of 2.
test('late start at close (5c): B records ENTRY_VOID on a real outage, then the player sends A a late first mark - FORFEIT at both, no refund signed, the lock held', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w);
    await w.downA();
    for (const m of run.messages) await say(w.b.port, m);                   // on time, then past the line, to B only (A down)
    await wait(500);
    const bVoidFirst = !!w.b.round.entryVoid(run.eid);
    await w.upA();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A
    await wait(1000);
    const before = { bVoidFirst, aLate: !!w.a.round.startForfeit(run.eid), aHoldsOnTime: holdsFirst(w.a, run),
      aVoid: !!w.a.round.entryVoid(run.eid), proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await pastResultWindow(w, decidedBoth(w, run));
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit,
        proof: d.round.equivocation(w.rid, run.eid).length };
    };
    // Each signer node's forfeit door is asked - A, then B, then A again (B's door may show A its Void).
    const after = { a: await at2(w.a), b: await at2(w.b) };
    after.aAgain = (await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    after.aVoidAfterDoors = !!w.a.round.entryVoid(run.eid);
    after.forfeitKept = [w.a, w.b].map((d) => !!d.round.forfeit(run.eid));
    after.lockHeld = lockHeldOf(w, run);
    console.log('  FACTS (late close 5c, ENTRY_VOID first):', JSON.stringify({ before, after }));
    assert.equal(before.bVoidFirst, true, 'B did not record ENTRY_VOID before the late mark: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].forfeit, 409, `${s} will sign the refund of the lock to the player`);
    }
    assert.equal(after.aAgain, 409, 'A signs the refund once B has shown it the Void');
    assert.equal(after.b.entryVoid, true, 'B\'s ENTRY_VOID record was not kept as history');
    assert.equal(after.aVoidAfterDoors, false, 'A recorded ENTRY_VOID from B\'s evidence');
    assert.deepEqual(after.forfeitKept, [false, false], 'a signer node keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// A SECOND ON-TIME FIRST MARK AFTER THE VOID (M3.3-34, ruled 2026-09-12, path 1):
// B down, A records ENTRY_VOID on a real outage, B back - and the player sends B
// a DIFFERENT on-time first mark. Same-mark Void evidence only: B refuses it and
// keeps the pair; FORFEIT at both, no refund signed, the lock held.
test('late start at close (5d): A records ENTRY_VOID on a real outage, then the player sends B a different on-time first mark - FORFEIT at both, no refund signed, the lock held', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);                   // on time, then past the line, to A only (B down)
    await wait(500);
    const aVoidFirst = !!w.a.round.entryVoid(run.eid);
    await w.upB();
    const saidB = [];
    for (const m of run.other) saidB.push(answer(await say(w.b.port, m)));  // a different on-time first mark, to B
    await wait(1000);
    const aDoor = await (await fetch(`http://127.0.0.1:${w.a.port}/entry-void?entry=${toHex(run.eid)}`)).json().catch(() => null);
    const before = { aVoidFirst, saidB, bVoid: !!w.b.round.entryVoid(run.eid),
      aVoidDoor: aDoor && { evidenceKind: aDoor.evidenceKind, evidence: !!aDoor.evidence, receipt: !!aDoor.receipt },
      bPeers: w.b.verifier.peersOf(w.rid).length,
      proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await pastResultWindow(w, decidedBoth(w, run));
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit,
        proof: d.round.equivocation(w.rid, run.eid).length };
    };
    // Each signer node's forfeit door - B, then A (whose door may show B its Void), then B again.
    const after = { b: await at2(w.b), a: await at2(w.a) };
    after.bAgain = (await fetch(`http://127.0.0.1:${w.b.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    after.bVoidAfterDoors = !!w.b.round.entryVoid(run.eid);
    after.forfeitKept = [w.a, w.b].map((d) => !!d.round.forfeit(run.eid));
    after.lockHeld = lockHeldOf(w, run);
    console.log('  FACTS (late close 5d, a second on-time first mark after the Void):', JSON.stringify({ before, after }));
    assert.equal(before.aVoidFirst, true, 'A did not record ENTRY_VOID before the second mark: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].forfeit, 409, `${s} will sign the refund of the lock to the player`);
    }
    assert.equal(after.bAgain, 409, 'B signs the refund once A has shown it the Void');
    assert.equal(after.a.entryVoid, true, 'A\'s ENTRY_VOID record was not kept as history');
    assert.equal(after.bVoidAfterDoors, false, 'B recorded ENTRY_VOID for a different first mark than the one A voided');
    assert.deepEqual(after.forfeitKept, [false, false], 'a signer node keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// A VOID SIGNER NODE THAT MISSED THE LATE MARK'S FORWARD (M3.3-34, ruled, path 2): A
// down, B records ENTRY_VOID; A back; B down while the player sends A a late
// first mark - so A's forward of it to B is lost; B back. The late mark is
// pullable proof: after the window, BEFORE any forfeit door is asked (a door can
// show a signer node the Void and make the pair there), both signer nodes hold the pair and
// close FORFEIT; then no door signs a refund, and the lock is held.
test('late start at close (5e): B records ENTRY_VOID, the late first mark reaches only A and its forward to B is lost - pulled at the close, FORFEIT at both, no refund', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w);
    await w.downA();
    for (const m of run.messages) await say(w.b.port, m);                   // on time, then past the line, to B only (A down)
    await wait(500);
    const bVoidFirst = !!w.b.round.entryVoid(run.eid);
    await w.upA();
    await w.downB();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A - its forward to B is lost (B down)
    await wait(500);
    await w.upB();
    await wait(500);
    const before = { bVoidFirst, aLate: !!w.a.round.startForfeit(run.eid), aVoid: !!w.a.round.entryVoid(run.eid),
      proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await pastResultWindow(w, decidedBoth(w, run));
    const state = (d) => {
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: !!d.round.entryVoid(run.eid), noQuorum: nq ? nq.outcome : null, finality: resultFinality(d.round, w.rid, run.eid).state,
        proof: d.round.equivocation(w.rid, run.eid).length, results: d.round.results(w.rid, run.eid).length };
    };
    const pulled = { a: state(w.a), b: state(w.b) };                        // after the window, before any door
    const door = async (d) => (await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    const doors = { b: await door(w.b), a: await door(w.a), bAgain: await door(w.b) };
    const after = { aVoid: !!w.a.round.entryVoid(run.eid), forfeitKept: [w.a, w.b].map((d) => !!d.round.forfeit(run.eid)), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 5e, the late mark\'s forward lost):', JSON.stringify({ before, pulled, doors, after }));
    assert.equal(before.bVoidFirst, true, 'B did not record ENTRY_VOID first: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    assert.equal(before.proofAtB, 0, 'B holds the pair before the close: the forward was not lost - not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(pulled[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT from the pull: ${JSON.stringify(pulled[s])}`);
      assert.equal(pulled[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(pulled[s])}`);
    }
    assert.ok(pulled.b.proof >= 1, 'B never pulled the late mark: the Void signer node has no pair');
    assert.equal(pulled.b.entryVoid, true, 'B\'s ENTRY_VOID record was not kept as history');
    assert.deepEqual(doors, { b: 409, a: 409, bAgain: 409 }, 'a forfeit door signs the refund of the lock to the player');
    assert.equal(after.aVoid, false, 'A recorded ENTRY_VOID from B\'s evidence');
    assert.deepEqual(after.forfeitKept, [false, false], 'a signer node keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});


// §13C'S EVIDENCE IS TIED TO ITS BLOCK (RULED 2026-09-24): a proof counts only when its block is strictly before the
// result window's end block, at every holder. THE LATE PROOF: B records ENTRY_VOID on a real outage and closes before the
// end block; past it B decides. Only then does the player's late first mark reach A, and A closes: the pair it can now
// make sits at or after the end block - outside at both. Both write the same record.
test('a proof after the result window\'s end block is outside at both holders: B decided without it, A that got it later writes the same record', async () => {
  const w = await signerNodes({ endIn: 15000 });
  try {
    const run = await joinAndBuild(w);
    await w.downA();
    for (const m of run.messages) await say(w.b.port, m);                   // on time, then past the line, to B only (A down)
    await wait(500);
    const bVoidFirst = !!w.b.round.entryVoid(run.eid);
    await w.upA();
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const bClosedBeforeEnd = testNow() < endMs;
    await say(w.b.port, `close ${toHex(w.rid)}`);
    await pastResultWindow(w, () => !!w.b.round.noQuorum(run.eid));
    const lateAfterEnd = testNow() >= endMs;
    for (const m of run.late) await say(w.a.port, m);                       // late, to A - after the end block
    await wait(500);
    await say(w.a.port, `close ${toHex(w.rid)}`);
    for (const stop = Date.now() + 15000; Date.now() < stop && !w.a.round.noQuorum(run.eid); await wait(100));
    const rec = (d) => { const nq = d.round.noQuorum(run.eid); return { outcome: nq ? nq.outcome : null, why: nq ? String(nq.why).slice(0, 120) : null,
      proof: d.round.provenTwoFirstMarks(w.rid, run.eid), voided: !!d.round.entryVoid(run.eid), late: !!d.round.startForfeit(run.eid),
      signed: d.round.results(w.rid, run.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }),
      finality: resultFinality(d.round, w.rid, run.eid).state }; };
    const after = { a: rec(w.a), b: rec(w.b) };
    console.log('  FACTS (late proof, result window):', JSON.stringify({ bVoidFirst, bClosedBeforeEnd, lateAfterEnd, after }));
    assert.equal(bVoidFirst, true, 'B did not record ENTRY_VOID: not the case the test names');
    assert.equal(bClosedBeforeEnd, true, 'B did not close before the end block: not the case the test names');
    assert.equal(lateAfterEnd, true, 'the late mark was not sent after the end block: not the case the test names');
    assert.equal(after.b.outcome, 'VOID', `B: ${JSON.stringify(after.b)}`);
    assert.equal(after.a.outcome, after.b.outcome, `the holders split on a proof after the end block: A ${after.a.outcome}, B ${after.b.outcome}`);
  } finally { await w.close(); }
});
