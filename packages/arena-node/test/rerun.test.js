// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SUSPENDED RESULT AND THE COMMITTEE'S RE-RUN (v4.6.2 §13A).
//
// "A valid objection suspends finality. The full committee re-runs the
// canonical transcript; the replay outcome is authoritative. Every node that
// signed the contradicted result is slashed (§5A.3). If the committee cannot
// reach 5-of-7 on the re-run, §13C applies."
//
// THE FIXTURE, measured before (TASKBOOK, 2f01ea1): seven signer nodes (the holder and
// six keys), five sign a result with the score rewritten, the holder's own
// replay contradicts it, an objection is filed inside an 800 ms window - and
// two windows later the run was still SUSPENDED, no share released, 0 re-run
// results, because the node had no re-run.
//
// Now the holder re-runs by itself when the objection holds, the other signer nodes'
// re-runs are counted, and 5 of 7 on one outcome replace SUSPENDED. Short of
// that by the end of the re-run window - one objection window from the filing -
// §13C decides (RULED 2026-09-24): VOID, or FORFEIT on proven equivocation.
import { testNow, skipTo } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { LockSettlement } from '../src/settlement.js';
import { Forfeit } from '../src/forfeit.js';
import { objectionIntake } from '../src/server.js';
import * as serverModule from '../src/server.js';
import { Verifier } from '../src/verify.js';
import { slashHoldsOnRerun, splitRerunSlashEvidence, slashProofId, REPLAY_CONTRADICTS, slashHolds, splitSlashEvidence } from '../../arena-protocol/src/slash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodePlayerResult, splitSignedResult, resultId, joinSignedResult, encodePlayerResult } from '../../arena-protocol/src/result.js';
import { runOf, decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { b32, rand, wait, sevenSignerNodes, object, objectionBundleFor, WINNER, WINDOW_MS } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';

/** Wait until the holder has signed its own re-run of `eid`, and return it. */
async function holdersRerun(w, eid, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const own = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey));
    if (own) return decodeRerunResult(splitSignedRerun(own.bytes).body);
    await wait(50);
  }
  return null;
}

// EVERY ROUND HERE ENDS A FEW SECONDS AHEAD (WINDOW-10-SPEC, RULED 2026-10-01): its windows run from the round's
// end on the wall clock - the objection window to + 600 s, the re-run window to + 1200 s (decided at + 1205 s), the
// re-run's own window to + 1800 s (FINAL signed from + 1805 s) - read at named instants or skipped to on the fixtures' clock.
const seven = (o = {}) => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, ...o });
const winOf = (w) => { const x = windowsOf(w.contract); return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number(v)])); };

/** The fixture: five sign the rewritten score, the objection is filed; returns the suspended run. */
async function suspended(w) {
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  assert.equal((await object(w, eid)).status, 201);
  const mine = w.holder.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
  // FILED WHEN IT REACHED THIS SEAT, on its clock (WINDOW-10-SPEC); every window of the entry runs from the round's end.
  return { eid, replay: decodePlayerResult(splitSignedResult(mine.bytes).body), filed: resultFinality(w.holder.round, w.rid, eid).filedAtMs, win: winOf(w) };
}

/** FINAL, AS A SEAT SEES IT (WINDOW-10-SPEC): past the run's final_after, the holder signs and four of the six sign too. */
async function signedFinal(w, name) {
  const eid = w.runs[name].eid;
  const f = resultFinality(w.holder.round, w.rid, eid);
  skipTo(Number(f.finalAfterMs) + 50);
  const q = `round=${toHex(w.rid)}&entry=${toHex(eid)}`;
  const own = await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`);
  if (own.status === 200) await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`, { method: 'POST', body: new Uint8Array(await own.arrayBuffer()) });
  await w.finalBy(name, 4);
  return resultFinality(w.holder.round, w.rid, eid);
}

/**
 * THE HOLDER'S STORE READ AT A CLOCK THE TEST NAMES, not a sleep (RULED 2026-09-24, slice C1). The re-run
 * window is WINDOW_MS from the filing, and the re-runs land 0.66-0.94 s after it (measured), so the fixture's 800 ms
 * window made whether they counted a matter of luck; every state below is read on the node's own clock, stubbed.
 */
const at = (w, now, over = {}) => Object.assign(Object.create(w.holder.round), { now: () => now }, over);

test('the committee re-runs a suspended result: the holder re-runs by itself, four signer nodes agree, and two windows later the re-run\'s outcome is FINAL and its share is released', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    const after = await signedFinal(w, 'dissents');                  // the re-run's own window over, and signed FINAL
    const may = new (w.holder.stakeSecrets.constructor)(w.holder.round, {}).mayRelease(w.rid, s.eid);
    const facts = {
      suspendedByTheObjection: state,
      holderReranItsReplay: toHex(runOf(own.result)) === toHex(runOf(s.replay)),
      holderNamedTheContradictedRun: toHex(own.contradictedRunId) === toHex(w.runs.dissents.contradicted),
      reruns: w.holder.round.reruns(w.rid, s.eid).length,
      after: after.state,
      authoritativeRun: after.runId === toHex(runOf(s.replay)),
      shareReleased: may.ok,
      outcome: may.outcome,
    };
    console.log('  FACTS (7 signer nodes, contradicted result, re-run 5 of 7):', JSON.stringify(facts), '|', after.why);
    assert.deepEqual(facts, {
      suspendedByTheObjection: 'SUSPENDED', holderReranItsReplay: true, holderNamedTheContradictedRun: true,
      reruns: 5, after: 'FINAL', authoritativeRun: true, shareReleased: true, outcome: 'FAILED',
    });
    assert.match(after.why, /re-run by 5 of 7 committee signer nodes, signed FINAL by 5 seats .*the replay outcome is authoritative/);
  } finally { await w.close(); }
});

// AN OBJECTED STOPPED RUN (M3.3-34 walk-away step 7): the winner's checkpoints
// cease at tick 600 while its run is still LIVE, so the close ends it FAILED at
// its last receipted checkpoint (§15, ruled 2026-09-12). Five signer nodes sign it with
// the score rewritten; the objection holds; the holder's own re-run must apply
// the same rule - FAILED at that checkpoint, the same score, the same run - and
// five of seven re-runs make that FINAL.
test('an objected stopped run is re-run under the same rule: FAILED at its last receipted checkpoint, the same run, FINAL at five of seven', async () => {
  const w = await seven({ play: { dissents: { ...WINNER, ticks: 600 } } });
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended stopped run');
    w.rerunBy('dissents', 4);
    const after = await signedFinal(w, 'dissents');
    const facts = {
      replay: `${s.replay.outcome}/${s.replay.score}`, suspendedByTheObjection: state,
      rerun: `${own.result.outcome}/${own.result.score}`, sameRun: toHex(runOf(own.result)) === toHex(runOf(s.replay)),
      reruns: w.holder.round.reruns(w.rid, s.eid).length, after: after.state, authoritativeRun: after.runId === toHex(runOf(s.replay)),
    };
    console.log('  FACTS (objected stopped run):', JSON.stringify(facts), '|', after.why);
    assert.match(facts.replay, /^FAILED\//, 'the stopped run did not end FAILED at its last receipted checkpoint');
    assert.deepEqual({ ...facts, replay: undefined, rerun: undefined },
      { replay: undefined, rerun: undefined, suspendedByTheObjection: 'SUSPENDED', sameRun: true, reruns: 5, after: 'FINAL', authoritativeRun: true });
    assert.equal(facts.rerun, facts.replay, 'the re-run did not apply the stopped rule the close applied');
  } finally { await w.close(); }
});

// RULED 2026-09-24 (§13A, ruling C, slice C1): this test said "two windows later the result is still SUSPENDED
// ... (13C, timed from the parked result window, is not applied)". The re-run window is one objection window from the
// filing, and no 5 of 7 by its end is §13C's rule - here VOID, no fork proof. Four re-runs two windows later are VOID.
test('four re-runs are not five: two windows later the result is VOID by §13C and no share leaves', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const later = at(w, s.win.rerunDeadlineMs);                         // the re-run window decided: end + 1205 s
    const after = resultFinality(later, w.rid, s.eid);
    const may = new (w.holder.stakeSecrets.constructor)(later, {}).mayRelease(w.rid, s.eid);
    assert.equal(after.state, 'VOID', `four re-runs, two windows later: ${after.why}`);
    assert.match(after.why, /with 4 of 5 re-runs on one outcome/);
    assert.equal(may.ok, false, 'a share left a result four signer nodes re-ran');
    assert.equal(may.state, 'VOID');
  } finally { await w.close(); }
});

// THE RE-RUN WINDOW'S EDGE, ON THE NODE'S OWN CLOCK AND NO SLEEP (§13A, §13C, RULED 2026-09-24, slice C1). The
// objection is filed inside the first window; the re-run window is objection_window_ms from the filing, so its end is
// never later than the third window. One millisecond before it the entry is SUSPENDED; at it, with four re-runs of
// five, VOID - and the VOID reaches the money: no share leaves (mayRelease), the lock settlement lists it as VOID
// rather than waiting on it, and the forfeit refuses to act, so the lock returns to the player at its expiry.
// Equivocation proven on this node's store makes the same instant FORFEIT: its share is released and the lock
// settlement lists it FORFEIT, score 0, on the finality alone - no stored no-quorum record.
test('a suspended entry is SUSPENDED one millisecond before its re-run window ends and VOID at it, and VOID and FORFEIT both reach the money', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const lag = w.holder.round.reruns(w.rid, s.eid).map((r) => r.seenMs - s.filed);
    const edge = s.win.rerunDeadlineMs;                                 // end + 1205 s: this seat decides
    // Only this entry's stake is counted seen: the fixture's other runs are short of a quorum and not what is measured.
    const mine = { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) };
    const inside = resultFinality(at(w, edge - 1), w.rid, s.eid);
    const ended = resultFinality(at(w, edge), w.rid, s.eid);
    const twoLater = resultFinality(at(w, s.win.ownFinalAfterMs), w.rid, s.eid);
    const released = new (w.holder.stakeSecrets.constructor)(at(w, edge), {}).mayRelease(w.rid, s.eid);
    const onRecord = new LockSettlement(at(w, edge, mine), {}).entriesOnRecord(w.rid, null);
    const forfeit = await new Forfeit(at(w, edge, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid);
    const proven = at(w, edge, { ...mine, provenTwoFirstMarks: () => true, noQuorum: () => null });
    const forfeited = resultFinality(proven, w.rid, s.eid);
    const provenRelease = new (w.holder.stakeSecrets.constructor)(proven, {}).mayRelease(w.rid, s.eid);
    const provenRecord = new LockSettlement(proven, {}).entriesOnRecord(w.rid, null);
    const outcomes = (r) => (r.ok ? r.entries.map((e) => `${e.outcome}/${e.score}`) : r.why);
    console.log('  FACTS:', JSON.stringify({ lag, inside: inside.state, ended: ended.state, twoLater: twoLater.state,
      released: released.ok, table: outcomes(onRecord), forfeit: forfeit.why,
      proven: forfeited.state, provenRelease, provenTable: outcomes(provenRecord) }));
    assert.ok(w.holder.round.reruns(w.rid, s.eid).every((r) => r.seenMs < s.win.rerunDeadlineMs), `a re-run landed outside its window: ${lag}`);
    assert.equal(inside.state, 'SUSPENDED', inside.why);
    assert.equal(ended.state, 'VOID', ended.why);
    assert.match(ended.why, /the re-run window closed at \S+ with 4 of 5 re-runs on one outcome \(§13A, §13C\)/);
    assert.equal(twoLater.state, 'VOID');
    assert.equal(released.ok, false, 'a share left a VOID entry');
    assert.deepEqual(outcomes(onRecord), ['VOID/0']);
    assert.equal(forfeit.ok, false);
    assert.match(forfeit.why, /that entry is VOID \(§13C\): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry/);
    assert.equal(forfeited.state, 'FORFEIT', forfeited.why);
    assert.deepEqual(provenRelease, { ok: true, outcome: 'FORFEIT', proven: true });
    assert.deepEqual(outcomes(provenRecord), ['FORFEIT/0'], 'a FORFEIT on the finality alone is not in the table');
  } finally { await w.close(); }
});

// A STORED §13C RECORD AND THE FINALITY'S OWN FORFEIT ARE ONE ENTRY IN THE TABLE, NOT TWO, and never the "not final" refusal.
test('a FORFEIT with a stored no-quorum record is listed once', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const both = at(w, s.win.rerunDeadlineMs, { stakeSeen: (eid) => toHex(eid) === toHex(s.eid), provenTwoFirstMarks: () => true,
      noQuorum: (eid) => (toHex(eid) === toHex(s.eid) ? { outcome: 'FORFEIT', why: 'stored' } : null) });
    const r = new LockSettlement(both, {}).entriesOnRecord(w.rid, null);
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(r.entries.map((e) => `${toHex(e.entryId) === toHex(s.eid)}:${e.outcome}/${e.score}`), ['true:FORFEIT/0']);
  } finally { await w.close(); }
});

// THE RE-RUN'S OWN OBJECTION WINDOW (§13A, RULED 2026-09-24, slice C2a). A re-run at 5 of 7 is provisionally
// final and gets one objection window of its own, opened when this node held it at threshold - the seenMs of the fifth
// agreeing re-run record - and objection_window_ms long. One millisecond before it closes the entry is
// PROVISIONALLY_FINAL and no share leaves; at its close, FINAL. Before this slice the agreed re-run was FINAL at once.
test('an agreed re-run is PROVISIONALLY_FINAL until its own objection window closes, then FINAL', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    const seen = w.holder.round.reruns(w.rid, s.eid).map((r) => r.seenMs).sort((a, b) => a - b);
    assert.equal(seen.length, 5);
    const agreed = resultFinality(w.holder.round, w.rid, s.eid).agreedAtMs;   // when this seat held the fifth agreeing re-run
    assert.ok(agreed < s.win.rerunDeadlineMs, `the fifth re-run landed at ${agreed - s.filed} ms, outside the re-run window`);
    const before = resultFinality(at(w, s.win.ownFinalAfterMs - 1), w.rid, s.eid);
    const may = new (w.holder.stakeSecrets.constructor)(at(w, s.win.ownFinalAfterMs - 1), {}).mayRelease(w.rid, s.eid);
    const closed = await signedFinal(w, 'dissents');
    console.log('  FACTS:', JSON.stringify({ agreedAfterFiling: agreed - s.filed, before: before.state, released: may.ok, closed: closed.state }),
      '|', before.why);
    assert.equal(before.state, 'PROVISIONALLY_FINAL', before.why);
    assert.equal(may.ok, false, 'a share left an agreed re-run inside its own objection window');
    assert.equal(closed.state, 'FINAL', closed.why);
    assert.match(closed.why, /re-run by 5 of 7 committee signer nodes, signed FINAL by 5 seats .*the replay outcome is authoritative/);
  } finally { await w.close(); }
});

// A SECOND VALID OBJECTION INSIDE THE RE-RUN'S OWN WINDOW VOIDS THE ENTRY (§13A, RULED 2026-09-24, slice C2b).
// Five of the other six keys re-run the objected result to another score, so the re-run is agreed at 5 of 7 without the
// holder, whose own re-run keeps the old score: a second objection holds here. Filed inside agreed + W, the entry is VOID
// at once - no third run - and the VOID goes the suspended entry's way to the money.
async function agreedWithoutTheHolder(w) {
  const s = await suspended(w);
  assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
  w.rerunBy('dissents', 5, { over: { score: s.replay.score + 2 } });
  const agreeing = w.holder.round.reruns(w.rid, s.eid).filter((r) => toHex(r.signerNodePubkey) !== toHex(w.holder.round.pubkey))
    .map((r) => r.seenMs).sort((a, b) => a - b);
  return { ...s, agreed: resultFinality(w.holder.round, w.rid, s.eid).agreedAtMs, own: s.win.ownFinalAfterMs };
}

test('a second valid objection inside the re-run\'s own objection window makes the entry VOID, and the VOID reaches the money', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    assert.equal(resultFinality(at(w, s.own - 1), w.rid, s.eid).state, 'PROVISIONALLY_FINAL');
    const second = await object(w, s.eid);
    assert.equal(second.status, 201, `the second objection was not taken: ${await second.text()}`);
    const filedSecondLocal = w.holder.round.rerunObjectedAt(w.rid, s.eid);
    const filedSecond = filedSecondLocal;
    const inside = resultFinality(at(w, s.own - 1), w.rid, s.eid);
    const closed = resultFinality(at(w, s.own), w.rid, s.eid);
    const threeLater = resultFinality(at(w, s.own + 3600000), w.rid, s.eid);
    const edge = s.own - 1;
    const released = new (w.holder.stakeSecrets.constructor)(at(w, edge), {}).mayRelease(w.rid, s.eid);
    const onRecord = new LockSettlement(at(w, edge, { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) }), {}).entriesOnRecord(w.rid, null);
    const forfeit = await new Forfeit(at(w, edge, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid);
    console.log('  FACTS:', JSON.stringify({ agreedAfterFiling: s.agreed - s.filed, secondAfterAgreed: filedSecond - s.agreed,
      inside: inside.state, closed: closed.state, threeLater: threeLater.state, released: released.ok,
      table: onRecord.ok ? onRecord.entries.map((e) => `${e.outcome}/${e.score}`) : onRecord.why }), '|', inside.why);
    assert.ok(filedSecond !== null && filedSecond >= s.agreed && filedSecond < s.own,
      `the second objection was stored at ${filedSecond}, not inside ${s.agreed}..${s.own}`);
    assert.equal(inside.state, 'VOID', inside.why);
    assert.match(inside.why, /a second valid objection, received here at \S+ before \S+, contradicts the agreed re-run too: two contradicted quorums in one entry - VOID, no third run \(13A\)/);
    assert.equal(closed.state, 'VOID', closed.why);
    assert.equal(threeLater.state, 'VOID', threeLater.why);
    assert.equal(released.ok, false, 'a share left an entry two objections voided');
    assert.equal(released.state, 'VOID');
    assert.deepEqual(onRecord.ok ? onRecord.entries.map((e) => `${e.outcome}/${e.score}`) : onRecord.why, ['VOID/0']);
    assert.equal(forfeit.ok, false);
    assert.match(forfeit.why, /that entry is VOID \(§13C\): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry/);
    // A THIRD OBJECTION IS THE SECOND AGAIN: no third run, nothing more stored.
    const third = await object(w, s.eid);
    assert.equal(third.status, 200);
    assert.equal((await third.text()).trim(), 'already objected');
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), filedSecondLocal);
  } finally { await w.close(); }
});

// AND OUTSIDE IT: a second objection at the re-run's window close is not counted, and the intake takes none (C2b).
test('a second objection at the re-run\'s window close counts for nothing, and the intake answers 409 and stores nothing', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    const close = at(w, s.own);                                         // end + 1805 s on this seat's clock
    const intake = objectionIntake(close, w.rid, s.eid);
    assert.deepEqual(intake, { status: 409, text: 'the re-run\'s objection window has closed' });
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null, 'the intake stored an objection after the window');
    assert.equal(close.objectRerun(w.rid, s.eid), true);                // written straight to the store at the close
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), s.own);
    const read = resultFinality(close, w.rid, s.eid);
    // NOT VOID: late, it suspends nothing - the re-run is signable FINAL here, and the objection is kept as evidence.
    assert.equal(read.state, 'PROVISIONALLY_FINAL', read.why);
    assert.ok(read.signable, read.why);
    assert.equal(read.lateObjection, true);
  } finally { await w.close(); }
});

// THE INTAKE'S REJECTS (C2b): while the run is still SUSPENDED an objection is the first one again; a missing entry or a
// round the entry is not in is 404, and this entry is unchanged.
test('while SUSPENDED an objection is the first again, and a missing or foreign entry is 404 with this entry unchanged', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    const again = await object(w, s.eid);
    assert.equal(again.status, 200);
    assert.equal((await again.text()).trim(), 'already objected');
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null, 'an objection while SUSPENDED was stored as the second');
    // a real bundle (§13A,: an empty body is 400 before anything is looked up), posted where it does not belong
    const { bundle } = await objectionBundleFor(w, s.eid);
    const missing = await fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(w.rid)}&entry=${toHex(rand(32))}`, { method: 'POST', body: bundle });
    assert.equal(missing.status, 404);
    const foreign = await fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(rand(32))}&entry=${toHex(s.eid)}`, { method: 'POST', body: bundle });
    assert.equal(foreign.status, 404);
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null);
    assert.equal(w.holder.round.objectedAt(w.rid, s.eid), s.filed);
    assert.equal(resultFinality(at(w, s.filed + 1), w.rid, s.eid).state, 'SUSPENDED');
    // AND NO RE-RUN SIGNER IS FILED AGAINST WHILE SUSPENDED (C2c): no re-run is agreed.
    const none = await new Verifier(at(w, s.filed + 1), { plugins: HOSTED, advertsFor: () => w.adverts, pool: {} }).fileRerunSlashProofs(w.rid, s.eid);
    assert.deepEqual(none.filed, []);
    assert.match(none.refused[0], /no second objection has made that entry VOID \(it is SUSPENDED\)/);
    assert.equal(rerunProofsOf(w, s.eid).length, 0);
  } finally { await w.close(); }
});

// SLASH PROOFS AGAINST THE AGREEING RE-RUN'S SIGNERS (§13A, §5A.3B, RULED 2026-09-24, slice C2c). When a second
// valid objection has made the entry VOID, "the signers of that result are slashed as well": the 201 that takes the
// second objection starts the filing, one REPLAY_CONTRADICTS proof per agreeing re-run signer - the accused's own signed
// re-run result as evidence, checked by slashHoldsOnRerun - and none against the holder, whose re-run dissented, or the
// first result's signers (the next cut). The money does not move with them.
const rerunProofsOf = (w, eid) => (typeof w.holder.round.rerunSlashProofs === 'function' ? w.holder.round.rerunSlashProofs(w.rid, eid) : []);
const agreeingRerunSigners = (w, eid, agreedRun) => w.holder.round.reruns(w.rid, eid)
  .map((r) => decodeRerunResult(splitSignedRerun(r.bytes).body).result)
  .filter((r) => toHex(runOf(r)) === agreedRun).map((r) => toHex(r.nodePubkey)).sort();

test('the second objection\'s 201 files one slash proof per agreeing re-run signer, each slashHoldsOnRerun accepts, and none against the holder', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    assert.equal(rerunProofsOf(w, s.eid).length, 0);
    assert.equal((await object(w, s.eid)).status, 201);
    const filed = rerunProofsOf(w, s.eid);
    console.log('  FACTS (C2c):', JSON.stringify({ proofs: filed.length }));
    assert.equal(filed.length, 5, 'the second objection filed no slash proof against the re-run\'s signers');
    const agreedRun = resultFinality(at(w, s.own - 1), w.rid, s.eid).runId;
    const canonical = w.holder.round.canonicalTranscript(w.rid, s.eid).hash;
    const committee = w.holder.round.signerNodes(w.rid);
    const checks = filed.map((p) => {
      const got = splitRerunSlashEvidence(p.bytes);
      return slashHoldsOnRerun({ proof: got.proof, signedRerun: got.signedRerun, advert: w.adverts.get(toHex(got.proof.nodePubkey)),
        committee, canonicalTranscriptHash: canonical, agreedRunId: fromHex(agreedRun), replayDiffers: true,
        verify: (sig, m, k) => schnorr.verify(sig, m, k) });
    });
    const relayed = [];
    for (const p of filed) {
      const r = await fetch(`http://127.0.0.1:${w.holder.port}/slash/${toHex(slashProofId(splitRerunSlashEvidence(p.bytes).proof))}`);
      relayed.push(r.status === 200 && toHex(new Uint8Array(await r.arrayBuffer())) === toHex(p.bytes));
    }
    const facts = {
      accusedAreTheAgreeing: filed.map((p) => toHex(p.nodePubkey)).sort().join() === agreeingRerunSigners(w, s.eid, agreedRun).join(),
      holderAccused: filed.some((p) => toHex(p.nodePubkey) === toHex(w.holder.round.pubkey)),
      eachSlashes: checks.every((c) => c.slashed && c.offence === REPLAY_CONTRADICTS),
      firstResultProofs: w.holder.round.slashProofs(w.rid, s.eid).length,
      relayKeepsEach: relayed.length === 5 && relayed.every(Boolean),
    };
    console.log('  FACTS (C2c proofs):', JSON.stringify(facts));
    // RULED 2026-09-24 (the first-result slash cut): the same 201 now files the first result's five signers too -
    // this said 0 while that was the next cut.
    assert.deepEqual(facts, { accusedAreTheAgreeing: true, holderAccused: false, eachSlashes: true, firstResultProofs: 5, relayKeepsEach: true });
  } finally { await w.close(); }
});

// THE FILING ITSELF, ON THE NODE'S OWN CLOCK STUBBED (C2c): nothing before the second objection - PROVISIONALLY_FINAL or
// a clean FINAL - and once it holds, one proof per agreeing signer; the holder, a stranger, a key whose re-run is another
// outcome and a signer with no advertisement refused by name and nothing stored for them; a second filing adds no row and
// publishes nothing; and the entry's money reads the same before the proofs and after them.
test('re-run slash proofs are filed only on a second-objection VOID, refused by name, deduped, and move no money', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    w.rerunBy('dissents', 1, { keys: [rand(32)], over: { score: s.replay.score + 2 } });           // a stranger, the agreed outcome
    w.rerunBy('dissents', 1, { keys: w.others.slice(5), over: { score: s.replay.score + 3 } });    // a signer, another outcome
    const inside = s.own - 1;
    const verifierAt = (now) => new Verifier(at(w, now), { plugins: HOSTED, advertsFor: () => w.adverts, pool: {} });
    const provisional = await verifierAt(inside).fileRerunSlashProofs(w.rid, s.eid);
    assert.deepEqual(provisional.filed, []);
    assert.match(provisional.refused[0], /no second objection has made that entry VOID \(it is PROVISIONALLY_FINAL\)/);
    assert.equal(rerunProofsOf(w, s.eid).length, 0);

    assert.equal(at(w, s.agreed + 100).objectRerun(w.rid, s.eid), true);   // the second objection, inside the window
    const mine = { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) };
    const money = async () => ({
      state: resultFinality(at(w, inside), w.rid, s.eid).state,
      released: new (w.holder.stakeSecrets.constructor)(at(w, inside), {}).mayRelease(w.rid, s.eid).ok,
      table: (({ ok, entries, why }) => (ok ? entries.map((e) => `${e.outcome}/${e.score}`) : why))(
        new LockSettlement(at(w, inside, mine), {}).entriesOnRecord(w.rid, null)),
      forfeit: (await new Forfeit(at(w, inside, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid)).why,
    });
    const before = await money();

    const agreedRun = resultFinality(at(w, inside), w.rid, s.eid).runId;
    const onCommittee = new Set(w.holder.round.signerNodes(w.rid).map(toHex));
    const signers = agreeingRerunSigners(w, s.eid, agreedRun).filter((k) => onCommittee.has(k));   // the stranger is not one
    assert.equal(signers.length, 5);
    const withheld = signers[0];
    const advert = w.adverts.get(withheld);
    w.adverts.delete(withheld);
    const first = await verifierAt(inside).fileRerunSlashProofs(w.rid, s.eid);
    w.adverts.set(withheld, advert);
    const second = await verifierAt(inside).fileRerunSlashProofs(w.rid, s.eid);
    const third = await verifierAt(inside + 3600000).fileRerunSlashProofs(w.rid, s.eid);   // after the window
    const after = await money();
    const rows = rerunProofsOf(w, s.eid).map((p) => toHex(p.nodePubkey)).sort();
    const refusedOf = (who) => first.refused.find((r) => r.startsWith(who.slice(0, 16))) || '';
    console.log('  FACTS (C2c filing):', JSON.stringify({ first: first.filed.length, second: second.filed.length, third: third.filed.length,
      published: [first.published, second.published, third.published], rows: rows.length, before, after }));
    assert.equal(first.filed.length, 4);
    assert.match(refusedOf(toHex(w.holder.round.pubkey)), /this node's own re-run, which dissented/);
    assert.ok(first.refused.some((r) => /is not on this round's committee/.test(r)), 'the stranger was not refused by name');
    assert.match(refusedOf(toHex(schnorr.getPublicKey(w.others[5]))), /is not among the agreeing re-runs/);
    assert.match(refusedOf(withheld), /no advertisement from the accused node to name its bond/);
    assert.deepEqual(second.filed, [withheld]);
    assert.deepEqual([third.filed, third.published], [[], 0]);
    assert.deepEqual([first.published, second.published], [4, 1]);
    assert.deepEqual(rows, signers);
    // (The first result's signers are filed too, on this VOID - by the holder's own re-run watch, which now runs to the
    // re-run's own FINAL on the round's clock (WINDOW-10-SPEC); fileRerunSlashProofs itself files none of them.)
    assert.ok(w.holder.round.slashProofs(w.rid, s.eid).every((p) => firstResultSigners(w, s.eid).includes(toHex(p.nodePubkey))),
      'a first-result proof names a key that did not sign the first result');
    assert.deepEqual(after, before);
    assert.deepEqual(before, { state: 'VOID', released: false, table: ['VOID/0'],
      forfeit: 'that entry is VOID (§13C): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry' });
  } finally { await w.close(); }
});

// THE FIRST RESULT'S SIGNERS ARE SLASHED WHEN THE ENTRY ENDS VOID - OR FORFEIT BY §13C (§13A, RULED 2026-09-24,
// ruling C steps 2 and 3: "the slashing of the first result's signers stands, because the objection that proved them wrong
// already exists"). The evidence is the existing one - the proof and the signer's own signed player result, slashHolds -
// in the existing slash_proofs table; the verdict is this node's own replay differing from the contradicted run. Filed by
// the 201 that takes a second objection, and by the re-run watch when it sees §13C's VOID or FORFEIT.
const firstFiling = async (v, rid, eid) => (typeof v.fileFirstResultSlashProofs === 'function'
  ? v.fileFirstResultSlashProofs(rid, eid) : { filed: [], refused: [], published: 0 });
const firstResultSigners = (w, eid) => w.holder.round.results(w.rid, eid)
  .map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((r) => toHex(runOf(r)) === toHex(w.runs.dissents.contradicted)).map((r) => toHex(r.nodePubkey)).sort();
const slashesEach = (w, eid, rows) => {
  const canonical = w.holder.round.canonicalTranscript(w.rid, eid).hash;
  const committee = w.holder.round.signerNodes(w.rid);
  return rows.every((p) => {
    const got = splitSlashEvidence(p.bytes);
    const c = slashHolds({ proof: got.proof, signedResult: got.signedResult, advert: w.adverts.get(toHex(got.proof.nodePubkey)),
      committee, canonicalTranscriptHash: canonical, replayDiffers: true });
    return c.slashed && c.offence === REPLAY_CONTRADICTS;
  });
};

test('the second objection\'s 201 also files one slash proof per first-result signer, and a signer of both results has a row in each table', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    w.rerunBy('dissents', 1, { keys: w.others.slice(5), over: { score: s.replay.score + 2 } });   // agreed, never signed the first
    assert.equal(w.holder.round.slashProofs(w.rid, s.eid).length, 0);
    assert.equal((await object(w, s.eid)).status, 201);
    const rows = w.holder.round.slashProofs(w.rid, s.eid);
    const firsts = firstResultSigners(w, s.eid);
    const both = rerunProofsOf(w, s.eid).map((p) => toHex(p.nodePubkey)).filter((k) => firsts.includes(k)).sort();
    console.log('  FACTS (first-result slash, 201):', JSON.stringify({ rows: rows.length, rerunRows: rerunProofsOf(w, s.eid).length, both: both.length }));
    assert.deepEqual(rows.map((p) => toHex(p.nodePubkey)).sort(), firsts);
    assert.equal(firsts.length, 5);
    assert.ok(slashesEach(w, s.eid, rows), 'a first-result proof slashHolds does not accept');
    assert.deepEqual(both, firsts, 'a signer of both results is missing a row in one table');
    assert.equal(rerunProofsOf(w, s.eid).length, 6);
    assert.ok(!rows.some((p) => toHex(p.nodePubkey) === toHex(schnorr.getPublicKey(w.others[5]))), 'the re-run-only signer got a first-result row');
  } finally { await w.close(); }
});

test('first-result proofs on a second-objection VOID: refused by name, deduped, and no money moves', async () => {
  const w = await seven();
  try {
    const s = await agreedWithoutTheHolder(w);
    w.rerunBy('dissents', 1, { keys: w.others.slice(5), over: { score: s.replay.score + 2 } });
    // A STRANGER'S signature on the contradicted run, beside the five.
    const stranger = rand(32);
    const mine = decodePlayerResult(splitSignedResult(w.holder.round.results(w.rid, s.eid)
      .find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey)).bytes).body);
    const five = decodePlayerResult(splitSignedResult(w.holder.round.results(w.rid, s.eid)
      .find((r) => toHex(r.nodePubkey) === firstResultSigners(w, s.eid)[0]).bytes).body);
    const forged = { ...five, nodePubkey: schnorr.getPublicKey(stranger) };
    const fid = resultId(forged);
    w.holder.round.putResult(w.rid, s.eid, forged.nodePubkey, fid, joinSignedResult(encodePlayerResult(forged), schnorr.sign(fid, stranger)));
    assert.notEqual(toHex(runOf(mine)), toHex(w.runs.dissents.contradicted));
    const inside = s.own - 1;
    const verifierAt = (now, over = {}) => new Verifier(at(w, now, over), { plugins: HOSTED, advertsFor: () => w.adverts, pool: {} });
    const early = await firstFiling(verifierAt(inside), w.rid, s.eid);
    assert.equal(w.holder.round.slashProofs(w.rid, s.eid).length, 0, 'a proof was filed while the re-run was PROVISIONALLY_FINAL');
    assert.equal(at(w, s.agreed + 100).objectRerun(w.rid, s.eid), true);
    const stake = { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) };
    const money = async () => ({
      state: resultFinality(at(w, inside), w.rid, s.eid).state,
      released: new (w.holder.stakeSecrets.constructor)(at(w, inside), {}).mayRelease(w.rid, s.eid).ok,
      table: (({ ok, entries, why }) => (ok ? entries.map((e) => `${e.outcome}/${e.score}`) : why))(
        new LockSettlement(at(w, inside, stake), {}).entriesOnRecord(w.rid, null)),
      forfeit: (await new Forfeit(at(w, inside, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid)).why,
    });
    const before = await money();
    const firsts = firstResultSigners(w, s.eid).filter((k) => k !== toHex(forged.nodePubkey));
    const withheld = firsts[0];
    const advert = w.adverts.get(withheld);
    w.adverts.delete(withheld);
    const first = await firstFiling(verifierAt(inside), w.rid, s.eid);
    w.adverts.set(withheld, advert);
    const second = await firstFiling(verifierAt(inside), w.rid, s.eid);
    const third = await firstFiling(verifierAt(inside + 3600000), w.rid, s.eid);
    const after = await money();
    const refusedOf = (who) => first.refused.find((r) => r.startsWith(who.slice(0, 16))) || '';
    console.log('  FACTS (first-result filing):', JSON.stringify({ early: early.filed.length, first: first.filed.length,
      second: second.filed, third: third.filed, published: [first.published, second.published, third.published], refused: first.refused }));
    assert.equal(early.filed.length, 0);
    assert.equal(first.filed.length, 4);
    assert.match(refusedOf(toHex(w.holder.round.pubkey)), /this node's own result, which is the replay/);
    assert.match(refusedOf(toHex(forged.nodePubkey)), /is not on this round's committee/);
    assert.match(refusedOf(toHex(schnorr.getPublicKey(w.others[5]))), /signed the re-run, not the contradicted result/);
    assert.match(refusedOf(withheld), /no advertisement names its bond/);
    assert.deepEqual(second.filed, [withheld]);
    assert.deepEqual([third.filed, third.published, third.refused.some((r) => r.startsWith(withheld.slice(0, 16)))], [[], 0, false]);
    assert.deepEqual([first.published, second.published], [4, 1]);
    assert.deepEqual(w.holder.round.slashProofs(w.rid, s.eid).map((p) => toHex(p.nodePubkey)).sort(), firsts);
    assert.deepEqual(after, before);
    assert.deepEqual(before, { state: 'VOID', released: false, table: ['VOID/0'],
      forfeit: 'that entry is VOID (§13C): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry' });
  } finally { await w.close(); }
});

test('§13C VOID at the re-run window\'s end files the five first-result signers on the stubbed clock, and FORFEIT with proven equivocation does too', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);                                                   // four of five: §13C at end + 1205 s
    const verifierAt = (now, over = {}) => new Verifier(at(w, now, over), { plugins: HOSTED, advertsFor: () => w.adverts, pool: {} });
    const D = s.win.rerunDeadlineMs;
    const suspendedStill = await firstFiling(verifierAt(D - 1), w.rid, s.eid);
    assert.equal(w.holder.round.slashProofs(w.rid, s.eid).length, 0, 'a proof was filed while SUSPENDED');
    const proven = { provenTwoFirstMarks: () => true };
    const forfeitState = resultFinality(at(w, D, proven), w.rid, s.eid).state;
    const forfeitReleased = new (w.holder.stakeSecrets.constructor)(at(w, D, proven), {}).mayRelease(w.rid, s.eid);
    const forfeited = await firstFiling(verifierAt(D, proven), w.rid, s.eid);
    const forfeitRows = w.holder.round.slashProofs(w.rid, s.eid).length;
    const forfeitAfter = new (w.holder.stakeSecrets.constructor)(at(w, D, proven), {}).mayRelease(w.rid, s.eid);
    console.log('  FACTS (13C first-result slash):', JSON.stringify({ suspended: suspendedStill.filed.length, forfeitState,
      forfeitFiled: forfeited.filed.length, forfeitRows }));
    assert.equal(suspendedStill.filed.length, 0);
    assert.equal(forfeitState, 'FORFEIT');
    assert.equal(forfeited.filed.length, 5);
    assert.equal(forfeitRows, 5);
    assert.deepEqual(forfeitAfter, forfeitReleased, 'the FORFEIT filing moved the money');
    assert.ok(slashesEach(w, s.eid, w.holder.round.slashProofs(w.rid, s.eid)));
    // AND THE SAME ROWS ON VOID: already stored, the VOID filing dedupes and files nothing more.
    const voided = await firstFiling(verifierAt(D), w.rid, s.eid);
    assert.equal(resultFinality(at(w, D), w.rid, s.eid).state, 'VOID');
    assert.deepEqual([voided.filed, voided.published], [[], 0]);
    assert.deepEqual(w.holder.round.slashProofs(w.rid, s.eid).map((p) => toHex(p.nodePubkey)).sort(), firstResultSigners(w, s.eid));
  } finally { await w.close(); }
});

test('§13C VOID on the real clock: the re-run watch, on its default budget, files the first-result signers itself', async () => {
  const w = await seven();                                   // no rerunMs shortcut
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    skipTo(s.win.rerunDeadlineMs + 50);                                           // the re-run window decided, on every clock
    const stop = Date.now() + 15000;                                              // the watch's next ticks, and margin
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, s.eid).length < 5) await wait(100);
    const rows = w.holder.round.slashProofs(w.rid, s.eid);
    console.log('  FACTS (13C watch):', JSON.stringify({ rows: rows.length, afterFilingMs: rows.length ? Math.max(...rows.map((p) => p.seenMs)) - s.filed : null,
      state: resultFinality(w.holder.round, w.rid, s.eid).state }));
    assert.equal(rows.length, 5, 'the watch stopped before §13C and filed no first-result proof');
    assert.deepEqual(rows.map((p) => toHex(p.nodePubkey)).sort(), firstResultSigners(w, s.eid));
    assert.ok(slashesEach(w, s.eid, rows));
    assert.ok(rows.every((p) => p.seenMs >= s.win.rerunDeadlineMs), 'a proof was filed before the re-run window ended');
  } finally { await w.close(); }
});

// THE ROUND SETTLES WITHOUT AN ENTRY STILL IN ITS RE-RUN WINDOW (§13A, RULED 2026-09-24, slice C3a). Today the
// settle gate (server.js) waits while any entry is SUSPENDED or PROVISIONALLY_FINAL, and entriesOnRecord refuses the
// whole round. Now: an entry still SUSPENDED, or PROVISIONALLY_FINAL on a re-run, is left out of the payout table and
// its lock is neither claimed nor forfeited; the rest settle as today. What its lock does after the round settled is
// read from the round's recorded claims and the entry's finality - VOID returns at expiry, FORFEIT or FAILED waits for
// the second settlement (C3b, not built), a qualifier's stake comes back by its own forfeit.
// TODAY'S GATE, literally (server.js before C3a): the settlement waited on every PROVISIONALLY_FINAL and SUSPENDED entry.
const settleWaitsOnToday = (standing) => standing.filter((x) => x.state === 'PROVISIONALLY_FINAL' || x.state === 'SUSPENDED');
const waitsOn = (standing) => (serverModule.settleWaitsOn || settleWaitsOnToday)(standing);
const lockAfter = (settlement, rid, eid) => (typeof settlement.lockAfterSettlement === 'function'
  ? settlement.lockAfterSettlement(rid, eid) : { claimed: false, why: 'lockAfterSettlement does not exist' });

async function settledWithOneObjected(w, reruns) {
  w.sign('agrees', () => ({}));
  const s = await suspended(w);
  assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
  w.rerunBy('dissents', reruns);
  // THE DECIDED RUN SIGNED FINAL past end + 605 s (WINDOW-10-SPEC), while the objected one is in its re-run window.
  const agreesFinal = await signedFinal(w, 'agrees');
  assert.equal(agreesFinal.state, 'FINAL', agreesFinal.why);
  const agreesId = w.runs.agrees.eid;
  // Each entry's verified lock, as the round's settlement names them; only these two stakes are counted seen.
  const lockOf = (eid) => ({ outpoint: `${toHex(eid)}:0`, fields: {} });
  const seen = new Set([toHex(agreesId), toHex(s.eid)]);
  const settledWith = (claimed) => ({ stakeSeen: (eid) => seen.has(toHex(eid)), stakeLock: (eid) => lockOf(eid),
    lockSettlementMoves: () => ({ txid: 'aa', claims: claimed.map((eid) => lockOf(eid).outpoint), payouts: 0 }) });
  return { ...s, agreesId, settledWith };
}

test('C3a: an entry still SUSPENDED is left out and the round settles without it; SUSPENDED, then VOID, then FORFEIT', async () => {
  const w = await seven();
  try {
    const s = await settledWithOneObjected(w, 3);                               // four of five: §13C at end + 1205 s
    const D = s.win.rerunDeadlineMs;
    const inWindow = at(w, D - 1, s.settledWith([s.agreesId]));
    const standing = [s.agreesId, s.eid].map((eid) => ({ entryId: toHex(eid), ...resultFinality(inWindow, w.rid, eid) }));
    const gate = waitsOn(standing);
    const on = new LockSettlement(inWindow, {}).entriesOnRecord(w.rid, null);
    console.log('  FACTS (C3a gate):', JSON.stringify({ states: standing.map((x) => x.state), waitsOn: gate.map((x) => x.state),
      onRecord: on.ok ? on.entries.map((e) => `${toHex(e.entryId).slice(0, 8)}:${e.outcome}`) : on.why }));
    assert.deepEqual(standing.map((x) => x.state), ['FINAL', 'SUSPENDED']);
    assert.deepEqual(gate, [], 'the settlement still waits on the suspended entry');
    assert.equal(on.ok, true, on.why);
    assert.deepEqual(on.entries.map((e) => toHex(e.entryId)), [toHex(s.agreesId)]);
    assert.ok(on.leftOut.some((x) => toHex(x.entryId) === toHex(s.eid) && /still in its re-run window/.test(x.why)));
    const settlement = new LockSettlement(inWindow, {});
    assert.match(lockAfter(settlement, w.rid, s.eid).why, /left out of the round's settlement: still in its re-run window/);
    assert.equal(lockAfter(settlement, w.rid, s.agreesId).claimed, true);
    const forfeitNow = await new Forfeit(at(w, D - 1, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid);
    assert.match(forfeitNow.why, /no forfeit before the result is final/);
    assert.equal(new (w.holder.stakeSecrets.constructor)(inWindow, {}).mayRelease(w.rid, s.eid).ok, false);
    // THEN VOID (§13C at end + 1205 s): nothing claims or forfeits it; the lock returns at expiry, the forfeit refuses.
    const voided = at(w, D, s.settledWith([s.agreesId]));
    assert.equal(resultFinality(voided, w.rid, s.eid).state, 'VOID');
    const afterVoid = lockAfter(new LockSettlement(voided, {}), w.rid, s.eid);
    assert.deepEqual([afterVoid.claimed, afterVoid.why], [false, 'VOID: nothing acts, and the lock returns to the player at its expiry']);
    assert.match((await new Forfeit(at(w, D, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid)).why,
      /that entry is VOID \(§13C\): nothing is forfeited/);
    // THEN FORFEIT (§13C with proven equivocation): not claimed in C3a, by name.
    const forfeited = at(w, D, { ...s.settledWith([s.agreesId]), provenTwoFirstMarks: () => true });
    assert.equal(resultFinality(forfeited, w.rid, s.eid).state, 'FORFEIT');
    const afterForfeit = lockAfter(new LockSettlement(forfeited, {}), w.rid, s.eid);
    assert.deepEqual([afterForfeit.claimed, afterForfeit.why], [false, 'claimed in the round\'s second settlement, not built yet']);
  } finally { await w.close(); }
});

test('C3a: an entry PROVISIONALLY_FINAL on its re-run is left out too, and once FINAL and FAILED its lock waits for the second settlement', async () => {
  const w = await seven();
  try {
    const s = await settledWithOneObjected(w, 4);                               // five of seven: an agreed re-run
    const seen = w.holder.round.reruns(w.rid, s.eid).map((r) => r.seenMs).sort((a, b) => a - b);
    const inWindow = at(w, s.win.ownFinalAfterMs - 1, s.settledWith([s.agreesId]));
    const standing = [s.agreesId, s.eid].map((eid) => ({ entryId: toHex(eid), ...resultFinality(inWindow, w.rid, eid) }));
    const on = new LockSettlement(inWindow, {}).entriesOnRecord(w.rid, null);
    assert.deepEqual(standing.map((x) => x.state), ['FINAL', 'PROVISIONALLY_FINAL']);
    assert.deepEqual(waitsOn(standing), [], 'the settlement still waits on the re-run inside its own window');
    assert.equal(on.ok, true, on.why);
    assert.deepEqual(on.entries.map((e) => toHex(e.entryId)), [toHex(s.agreesId)]);
    // AN ORDINARY PROVISIONALLY_FINAL - inside its first objection window, no re-run - is still waited on.
    assert.deepEqual(waitsOn([{ entryId: 'x', state: 'PROVISIONALLY_FINAL' }]).length, 1);
    // THEN FINAL, the replay FAILED: not claimed in C3a, by name; not a qualifier, so no forfeit either.
    const signed = await signedFinal(w, 'dissents');
    assert.equal(signed.state, 'FINAL', signed.why);
    const final = at(w, s.win.ownFinalAfterMs + 100, s.settledWith([s.agreesId]));
    const f = resultFinality(final, w.rid, s.eid);
    assert.equal(f.state, 'FINAL', f.why);
    const afterFinal = lockAfter(new LockSettlement(final, {}), w.rid, s.eid);
    assert.deepEqual([afterFinal.claimed, afterFinal.why], [false, 'claimed in the round\'s second settlement, not built yet']);
    assert.match((await new Forfeit(at(w, s.win.ownFinalAfterMs + 100, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid)).why,
      /not a qualifier, so its stake lock is not forfeited|this signer node verified no stake lock|no share of the round's claim key/);
  } finally { await w.close(); }
});

test('re-runs from keys that are not assigned, about another contradicted run, or to another outcome count for nothing', async () => {
  const w = await seven();
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 2);                                                           // two honest: 3 with the holder
    w.rerunBy('dissents', 2, { keys: [rand(32), rand(32)] });                           // two strangers
    w.rerunBy('dissents', 1, { keys: w.others.slice(2), contradicted: b32(0x66) });     // another contradicted run
    w.rerunBy('dissents', 1, { keys: w.others.slice(3), over: { score: s.replay.score + 2 } }); // another outcome
    const after = resultFinality(at(w, s.win.rerunDeadlineMs - 1), w.rid, s.eid);   // inside the re-run window
    assert.equal(after.state, 'SUSPENDED', `strangers, another run or another outcome made five: ${after.why}`);
    assert.match(after.why, /3 of 5 committee signer nodes have re-run/);
  } finally { await w.close(); }
});
