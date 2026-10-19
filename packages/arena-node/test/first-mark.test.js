// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LATE FIRST MARK IS FORFEIT AT BOTH SIGNER NODES (§15, §13C), AND IS FORWARDED.
//
// The rule (protocol first-mark.js): a first mark signed at a tick after
// join_tick + the round's start deadline is the player's own late start -
// FORFEIT, not ENTRY_VOID: a refund the player could choose by starting late is
// one §13C forbids. The signer node refuses the mark and keeps it as evidence. A first
// mark in time decides nothing, even where one signer node has not seen it. No first
// mark at all is FORFEIT at the round's close (§15's walk-away, ruled
// 2026-09-12: protocol stoppedOutcome) - never ENTRY_VOID, never a refund.
//
// Forwarding: a signer node that takes or refuses a first mark hands it - with the
// batches it commits to - to the round's other signer nodes, so a signer node the player
// never reached holds it (and a late one is FORFEIT there too).
//
// Two in-process signer nodes of a lock round, the fixture's delivering winner (join
// tick 0): a run of inputs 0..59, a mark at 60, inputs 60..1319, a mark at 1320.
// A LATE run is the same drive with its FIRST mark at 1320. The round omits the
// deadline: 900 ticks. The lock is not spent: until W4 a FORFEIT lock refunds
// at expiry, the money hole every loser has.
//
// MEASURED BEFORE (tools/entry-void-before.mjs, cc3102b): no signer node recorded
// anything for a late start, no signer node forwarded a mark, and a down signer node caught
// up late turned DELIVERED.
import { test } from 'node:test';
import {
  CLOCK, END, FIELD, GENESIS_HASH, NO_PREVIOUS, RANDOMNESS, SIGNED_FORFEIT_0, STAKE, START_DEADLINE_TICKS, TEST_FEDERATION_ID, WINDOW_MS, WINNER, answer, assert, assumeAssigned, b32, batchId, brief, checkpointId, closeAndSettle, closingOf, contractFor, curve, dealHandout, decidedBoth, decodePlayerResult, ed25519, encodeCheckpoint, encodeEntryContract, encodeHandout, encodeInputBatch, encodeRoundContract, entryFeeMsat, entryId, feldmanGroup, finalAtBoth, handoutId, holdsFirst, init, joinAndBuild, joinSigned, lockFieldsToJson, lockHeldOf, lockPort, netStakeMsat, openStore, opts, outcomeAt, pastResultWindow, presentDay, rand, refundKeyOf, resultFinality, roundEndMs, roundId, say, scalarFrom32, secretScalar, seedWordForEntry, serve, sha256, signedAt, signerNodes, splitSignedResult, stateHash, step, toHex, transcriptsAcross, tweakPoint, untilForwarded, wait, wordsAt,
} from './first-mark-fixture.js';

test('a first mark in time decides nothing - at both signer nodes with the player at both, and at B by forward when the player reaches only A', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    // THE PLAYER REACHES ONLY A with the first batch and mark; A forwards them to B.
    const saidA = [];
    for (const m of run.messages.slice(0, 2)) saidA.push(answer(await say(w.a.port, m)));
    const forwarded = await untilForwarded(w.b, run);
    const bReceipted = w.b.round.receiptCount(run.firstId);
    // AND THE REST OF THE RUN TO BOTH, so it can settle.
    for (const m of run.messages.slice(2)) for (const d of [w.a, w.b]) await say(d.port, m);
    await closeAndSettle(w, run);
    const facts = { deadline: START_DEADLINE_TICKS, firstMarkTick: 60, saidA, bHoldsTheFirstMarkByForward: forwarded,
      receiptsOfTheFirstMarkAtB: bReceipted, a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run) };
    console.log('  FACTS (in time):', JSON.stringify(facts));
    assert.deepEqual(facts, { deadline: 900, firstMarkTick: 60, saidA: ['60', 'receipt'], bHoldsTheFirstMarkByForward: true,
      receiptsOfTheFirstMarkAtB: 2,
      a: { lateStart: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 },
      b: { lateStart: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 } });
  } finally { await w.close(); }
});

test('a first mark after join + deadline is FORFEIT at the signer node it reaches, and at the other by forward; nothing is DELIVERED', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    const forwarded = await untilForwarded(w.b, run);
    await closeAndSettle(w, run);
    const facts = { firstMarkTick: END, saidA: saidA.map((s) => s.replace(/: the first mark.*/, '')), bForfeitByForward: forwarded,
      a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run), aStoredTheMark: holdsFirst(w.a, run) };
    console.log('  FACTS (late):', JSON.stringify(facts));
    // RULED 2026-09-12 (M3.3-34, late start at close): signed FORFEIT at the
    // close, FINAL 2 of 2. Measured before: results [], finality null.
    assert.deepEqual(facts, { firstMarkTick: 1320, saidA: ['1320', 'error FORFEIT'], bForfeitByForward: true,
      a: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      aStoredTheMark: false });
  } finally { await w.close(); }
});

// A REFUSED FIRST MARK NOBODY CARRIED IS NOT A SIGNED FIRST MARK (§13B).
//
// Measured on the Daily, one paid entry, both seats: the first mark went out at tick 5940 against a window
// ending at 900 and was refused as a late start. Nothing was carried - `checkpoints` and `offered_marks`
// held 0 rows for that entry on both seats - so the client's head was still ZERO and it marked again, the
// way a client with no head does. All 80 of those were answered "the player signed another first mark for
// this entry (§13B): two first marks are FORFEIT, never an outage refund".
//
// The player forked nothing. They were told no and asked again. 13B's clause is the one that forecloses
// an outage refund, so charging it on the strength of this node's own refusal is the operator profiting
// from a technical failure. The retry is answered the way the first one was.
test('a late first mark refused and never carried: marking again past the line is that same late start, not two first marks', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    for (const m of run.messages) await say(w.a.port, m);
    assert.equal(await untilForwarded(w.b, run), true, 'B never learned the late start');
    assert.equal(holdsFirst(w.b, run), false, 'B carried the late mark, so this is not the measured case');

    // THE RETRY, TO THE SIGNER NODE THAT REFUSED AND KEPT NOTHING.
    const said = [];
    for (const m of run.again) said.push(answer(await say(w.b.port, m)));
    const pairs = await (await fetch(`http://127.0.0.1:${w.b.port}/equivocation?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).text();
    const facts = { said, twoFirstMarks: /two first marks/i.test(said.join(' ')),
      pairKept: !/none|no proof/i.test(pairs) && pairs.length > 64, b: await outcomeAt(w.b, w, run) };
    console.log('  FACTS (retry past the line):', JSON.stringify(facts).slice(0, 400));
    assert.equal(facts.twoFirstMarks, false, `the retry was charged as a fork: ${said.join(' ')}`);
    assert.match(said.join(' '), /after the start deadline/, 'the retry was not answered with the late start');
    assert.equal(facts.pairKept, false, 'a fork pair was kept against a player who forked nothing');
    assert.equal(facts.b.lateStart, 'FORFEIT at 1320 > 900', 'the late start this signer node already held moved');

    // AND THE DOOR DOES NOT OPEN. A mark INSIDE the window after a late start was refused would claim a
    // start this signer node said was missed - that is the second first mark 13B is for, and it still is.
    const inside = [];
    for (const m of run.other) inside.push(answer(await say(w.b.port, m)));
    console.log(`  FACTS (retry inside the window): ${JSON.stringify(inside)}`);
    assert.match(inside.join(' '), /two first marks/i,
      `an on-time mark after a refused late start was not refused as a second first mark: ${inside.join(' ')}`);
  } finally { await w.close(); }
});

test('a down signer node caught up late with a late first mark does not turn DELIVERED: it is FORFEIT there too', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    await w.downB();
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    await w.upB();
    const saidB = [];
    for (const m of run.messages) saidB.push(answer(await say(w.b.port, m)));
    await closeAndSettle(w, run);
    const facts = { saidA: saidA.map((s) => s.replace(/: the first mark.*/, '')), saidB: saidB.map((s) => s.replace(/: the first mark.*/, '')),
      a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run) };
    console.log('  FACTS (caught up late):', JSON.stringify(facts));
    // RULED 2026-09-12 (M3.3-34, late start at close): signed FORFEIT at the
    // close, FINAL 2 of 2. Measured before: results [], finality null.
    assert.deepEqual(facts, { saidA: ['1320', 'error FORFEIT'], saidB: ['1320', 'error FORFEIT'],
      a: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 } });
  } finally { await w.close(); }
});

// MEASURED BEFORE the ruling (2026-09-12, no-mark-probe.mjs): no result at either
// signer node, finality null, and the lock back to the player at its expiry.
test('no first mark at all is FORFEIT at both signer nodes at the close - final 2 of 2, never ENTRY_VOID, the lock not handed back', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await closeAndSettle(w, run);
    const facts = { a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run),
      lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (no mark):', JSON.stringify(facts));
    assert.deepEqual(facts, { a: { lateStart: null, results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: null, results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 }, lockHeld: true });
  } finally { await w.close(); }
});


// LATE START AT THE CLOSE (M3.3-34, ruled 2026-09-12). A joined player whose
// first mark came after join tick + the start deadline has forfeited, whenever
// the close comes: FORFEIT, score 0, over the empty receipted transcript,
// signed by both signer nodes, FINAL 2 of 2 - not VOID, not ENTRY_VOID, not FAILED,
// nothing refunded, the lock held. The same FORFEIT 0 as no mark at all,
// whichever signer node recorded the late mark. MEASURED BEFORE: FORFEIT recorded at
// the door, no signed result at either signer node, finality null.

test('late start at close (1): a late first mark at both signer nodes is signed FORFEIT 0 by both, one transcript, FINAL 2 of 2, the lock held', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    for (const m of run.messages) await say(w.a.port, m);
    await untilForwarded(w.b, run);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { a, b, transcriptsAcrossSignerNodes: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 1):', JSON.stringify(facts));
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSignerNodes, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: true }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (2): signer node B down, then caught up late - both sign the same FORFEIT 0, FINAL 2 of 2', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);
    await w.upB();
    for (const m of run.messages) await say(w.b.port, m);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { a, b, transcriptsAcrossSignerNodes: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 2):', JSON.stringify(facts));
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSignerNodes, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: true }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (3): the late mark reached A only and its forward was lost - B never saw it, and both still sign the same FORFEIT 0', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);
    await w.upB();                              // nobody catches B up
    await wait(1000);
    const bSawIt = !!w.b.round.startForfeit(run.eid);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { bSawTheLateMarkBeforeTheClose: bSawIt, a, b, transcriptsAcrossSignerNodes: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 3):', JSON.stringify(facts));
    assert.equal(bSawIt, false, 'B was handed the late mark: this is not the case the test names');
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSignerNodes, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: false }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (4): the peer is down at the close - the signer node holds, signs nothing, and both sign FORFEIT 0 when it is back', async () => {
  const w = await signerNodes({ endIn: 9000 });                 // a round in the present: its result window still open (WINDOW-10-SPEC)
  try {
    const run = await joinAndBuild(w, { firstAt: END });
    for (const m of run.messages) await say(w.a.port, m);
    await untilForwarded(w.b, run);
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    const held = await closingOf(w.a, w, run);
    const whileDown = await signedAt(w.a, w, run);
    await w.upB();
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
    const final = await finalAtBoth(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { held: held && { state: held.state, attempts: held.attempts, why: String(held.lastWhy).slice(0, 40) },
      whileDown: brief(whileDown), final, a, b, transcriptsAcrossSignerNodes: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 4):', JSON.stringify(facts));
    assert.equal(held.state, 'HOLDING');
    assert.match(held.lastWhy, /waiting on 1 signer node/);
    assert.deepEqual(whileDown.results, []);
    assert.equal(whileDown.signers, 0);
    assert.deepEqual({ a: brief(a), b: brief(b), n: facts.transcriptsAcrossSignerNodes, lockHeld: facts.lockHeld },
      { a: SIGNED_FORFEIT_0, b: SIGNED_FORFEIT_0, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

// THE GUARD (ruled required): a signer node holding only a late first mark waits while
// any other signer node is unreachable, because that signer node may hold an on-time first
// mark. How such a conflict resolves is ENTRY_VOID territory - parked; only the
// hold is measured here.
test('late start at close (5): an on-time first mark at B and a late one at A, B down at A\'s close - A holds and signs nothing', async () => {
  const w = await signerNodes({ endIn: 9000 });                 // a round in the present: its result window still open (WINDOW-10-SPEC)
  try {
    const run = await joinAndBuild(w);
    await w.downA();
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(answer(await say(w.b.port, m)));
    await w.upA();
    const saidA = [];
    for (const m of run.late) saidA.push(answer(await say(w.a.port, m)).replace(/: the first mark.*/, ''));
    await wait(500);
    const bHeld = { onTimeFirstMark: holdsFirst(w.b, run), lateStart: !!w.b.round.startForfeit(run.eid) };
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    const held = await closingOf(w.a, w, run);
    const atA = await signedAt(w.a, w, run);
    const facts = { saidB, saidA, bBeforeItWentDown: bHeld, aLateStart: atA.lateStart,
      held: held && { state: held.state, attempts: held.attempts, why: String(held.lastWhy).slice(0, 40) }, atA: brief(atA) };
    console.log('  FACTS (late close 5, guard):', JSON.stringify(facts));
    assert.equal(bHeld.onTimeFirstMark, true, 'B does not hold the on-time first mark: this is not the case the test names');
    assert.equal(atA.lateStart, true, 'A recorded no late start: this is not the case the test names');
    assert.equal(held.state, 'HOLDING');
    // THE REASON, RULED 2026-09-13 (M3.3-34, Plan A): A now holds the proof of the
    // two first marks before its close - B's FORFEIT answer to A's forward makes A
    // pull it - and a signer node holding the proof does not wait on a down signer node. It still
    // holds and signs nothing; before Plan A this read "waiting on 1 signer node".
    assert.match(held.lastWhy, /no quorum yet: the player signed two first marks for this entry - one of them late \(§13B\)/);
    assert.deepEqual(atA.results, []);
    assert.equal(atA.signers, 0);
  } finally { await w.close(); }
});


test('late start at close (7): a late mark after both signer nodes have signed FORFEIT 0 changes nothing - the same result, the same transcript', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await closeAndSettle(w, run);
    const beforeA = await signedAt(w.a, w, run);
    const beforeB = await signedAt(w.b, w, run);
    const saidA = [];
    for (const m of run.late) saidA.push(answer(await say(w.a.port, m)).slice(0, 60));
    await wait(1000);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { before: { a: brief(beforeA), b: brief(beforeB), transcripts: [...new Set([...beforeA.transcripts, ...beforeB.transcripts])] },
      saidA, after: { a: brief(a), b: brief(b), transcripts: [...new Set([...a.transcripts, ...b.transcripts])] }, lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 7):', JSON.stringify(facts));
    assert.deepEqual(facts.before.a, SIGNED_FORFEIT_0);
    assert.deepEqual(facts.after, { a: SIGNED_FORFEIT_0, b: SIGNED_FORFEIT_0, transcripts: facts.before.transcripts });
    assert.equal(facts.before.transcripts.length, 1);
    assert.equal(facts.lockHeld, true);
  } finally { await w.close(); }
});

