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
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { LockSettlement } from '../src/settlement.js';
import { Forfeit } from '../src/forfeit.js';
import { objectionIntake } from '../src/server.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { runOf, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { toHex } from '../../protocol/src/hash.js';
import { b32, rand, wait, sevenSignerNodes, object, WINNER, WINDOW_MS } from './window-fixture.js';

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

/** The fixture: five sign the rewritten score, the objection is filed; returns the suspended run. */
async function suspended(w) {
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  assert.equal((await object(w, eid)).status, 201);
  const mine = w.holder.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
  return { eid, replay: decodePlayerResult(splitSignedResult(mine.bytes).body), filed: w.holder.round.objectedAt(w.rid, eid) };
}

/**
 * THE HOLDER'S STORE READ AT A CLOCK THE TEST NAMES, not a sleep (RULED the owner 2026-09-24, slice C1). The re-run
 * window is WINDOW_MS from the filing, and the re-runs land 0.66-0.94 s after it (measured), so the fixture's 800 ms
 * window made whether they counted a matter of luck; every state below is read on the node's own clock, stubbed.
 */
const at = (w, now, over = {}) => Object.assign(Object.create(w.holder.round), { now: () => now }, over);

test('the committee re-runs a suspended result: the holder re-runs by itself, four signer nodes agree, and two windows later the re-run\'s outcome is FINAL and its share is released', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    const later = at(w, s.filed + 2 * WINDOW_MS);                     // two windows, as measured before
    const after = resultFinality(later, w.rid, s.eid);
    const may = new (w.holder.preimages.constructor)(later, {}).mayRelease(w.rid, s.eid);
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
    assert.match(after.why, /re-run by 5 of 7 committee signer nodes: the replay outcome is authoritative/);
  } finally { await w.close(); }
});

// AN OBJECTED STOPPED RUN (M3.3-34 walk-away step 7): the winner's checkpoints
// cease at tick 600 while its run is still LIVE, so the close ends it FAILED at
// its last receipted checkpoint (§15, ruled 2026-09-12). Five signer nodes sign it with
// the score rewritten; the objection holds; the holder's own re-run must apply
// the same rule - FAILED at that checkpoint, the same score, the same run - and
// five of seven re-runs make that FINAL.
test('an objected stopped run is re-run under the same rule: FAILED at its last receipted checkpoint, the same run, FINAL at five of seven', async () => {
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { play: { dissents: { ...WINNER, ticks: 600 } } });
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended stopped run');
    w.rerunBy('dissents', 4);
    const after = resultFinality(at(w, s.filed + 2 * WINDOW_MS), w.rid, s.eid);
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

// RULED the owner 2026-09-24 (§13A, ruling C, slice C1): this test said "two windows later the result is still SUSPENDED
// ... (13C, timed from the parked result window, is not applied)". The re-run window is one objection window from the
// filing, and no 5 of 7 by its end is §13C's rule - here VOID, no fork proof. Four re-runs two windows later are VOID.
test('four re-runs are not five: two windows later the result is VOID by §13C and no share leaves', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const later = at(w, s.filed + 2 * WINDOW_MS);
    const after = resultFinality(later, w.rid, s.eid);
    const may = new (w.holder.preimages.constructor)(later, {}).mayRelease(w.rid, s.eid);
    assert.equal(after.state, 'VOID', `four re-runs, two windows later: ${after.why}`);
    assert.match(after.why, /with 4 of 5 re-runs on one outcome/);
    assert.equal(may.ok, false, 'a share left a result four signer nodes re-ran');
    assert.equal(may.state, 'VOID');
  } finally { await w.close(); }
});

// THE RE-RUN WINDOW'S EDGE, ON THE NODE'S OWN CLOCK AND NO SLEEP (§13A, §13C, RULED the owner 2026-09-24, slice C1). The
// objection is filed inside the first window; the re-run window is objection_window_ms from the filing, so its end is
// never later than the third window. One millisecond before it the entry is SUSPENDED; at it, with four re-runs of
// five, VOID - and the VOID reaches the money: no share leaves (mayRelease), the lock settlement lists it as VOID
// rather than waiting on it, and the forfeit refuses to act, so the lock returns to the player at its expiry.
// Equivocation proven on this node's store makes the same instant FORFEIT: its share is released and the lock
// settlement lists it FORFEIT, score 0, on the finality alone - no stored no-quorum record.
test('a suspended entry is SUSPENDED one millisecond before its re-run window ends and VOID at it, and VOID and FORFEIT both reach the money', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const lag = w.holder.round.reruns(w.rid, s.eid).map((r) => r.seenMs - s.filed);
    const edge = s.filed + WINDOW_MS;
    // Only this entry's stake is counted seen: the fixture's other runs are short of a quorum and not what is measured.
    const mine = { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) };
    const inside = resultFinality(at(w, edge - 1), w.rid, s.eid);
    const ended = resultFinality(at(w, edge), w.rid, s.eid);
    const twoLater = resultFinality(at(w, s.filed + 2 * WINDOW_MS), w.rid, s.eid);
    const released = new (w.holder.preimages.constructor)(at(w, edge), {}).mayRelease(w.rid, s.eid);
    const onRecord = new LockSettlement(at(w, edge, mine), {}).entriesOnRecord(w.rid, null);
    const forfeit = await new Forfeit(at(w, edge, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid);
    const proven = at(w, edge, { ...mine, provenTwoFirstMarks: () => true, noQuorum: () => null });
    const forfeited = resultFinality(proven, w.rid, s.eid);
    const provenRelease = new (w.holder.preimages.constructor)(proven, {}).mayRelease(w.rid, s.eid);
    const provenRecord = new LockSettlement(proven, {}).entriesOnRecord(w.rid, null);
    const outcomes = (r) => (r.ok ? r.entries.map((e) => `${e.outcome}/${e.score}`) : r.why);
    console.log('  FACTS:', JSON.stringify({ lag, inside: inside.state, ended: ended.state, twoLater: twoLater.state,
      released: released.ok, table: outcomes(onRecord), forfeit: forfeit.why,
      proven: forfeited.state, provenRelease, provenTable: outcomes(provenRecord) }));
    assert.ok(lag.every((ms) => ms < WINDOW_MS), `a re-run landed outside its window: ${lag}`);
    assert.equal(inside.state, 'SUSPENDED', inside.why);
    assert.equal(ended.state, 'VOID', ended.why);
    assert.match(ended.why, /the re-run window closed at \d+ .* with 4 of 5 re-runs on one outcome \(§13A, §13C\)/);
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
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    const both = at(w, s.filed + WINDOW_MS, { stakeSeen: (eid) => toHex(eid) === toHex(s.eid), provenTwoFirstMarks: () => true,
      noQuorum: (eid) => (toHex(eid) === toHex(s.eid) ? { outcome: 'FORFEIT', why: 'stored' } : null) });
    const r = new LockSettlement(both, {}).entriesOnRecord(w.rid, null);
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(r.entries.map((e) => `${toHex(e.entryId) === toHex(s.eid)}:${e.outcome}/${e.score}`), ['true:FORFEIT/0']);
  } finally { await w.close(); }
});

// THE RE-RUN'S OWN OBJECTION WINDOW (§13A, RULED the owner 2026-09-24, slice C2a). A re-run at 5 of 7 is provisionally
// final and gets one objection window of its own, opened when this node held it at threshold - the seenMs of the fifth
// agreeing re-run record - and objection_window_ms long. One millisecond before it closes the entry is
// PROVISIONALLY_FINAL and no share leaves; at its close, FINAL. Before this slice the agreed re-run was FINAL at once.
test('an agreed re-run is PROVISIONALLY_FINAL until its own objection window closes, then FINAL', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    const seen = w.holder.round.reruns(w.rid, s.eid).map((r) => r.seenMs).sort((a, b) => a - b);
    assert.equal(seen.length, 5);
    const agreed = seen[4];
    assert.ok(agreed < s.filed + WINDOW_MS, `the fifth re-run landed at ${agreed - s.filed} ms, outside the re-run window`);
    const before = resultFinality(at(w, agreed + WINDOW_MS - 1), w.rid, s.eid);
    const may = new (w.holder.preimages.constructor)(at(w, agreed + WINDOW_MS - 1), {}).mayRelease(w.rid, s.eid);
    const closed = resultFinality(at(w, agreed + WINDOW_MS), w.rid, s.eid);
    console.log('  FACTS:', JSON.stringify({ agreedAfterFiling: agreed - s.filed, before: before.state, released: may.ok, closed: closed.state }),
      '|', before.why);
    assert.equal(before.state, 'PROVISIONALLY_FINAL', before.why);
    assert.equal(may.ok, false, 'a share left an agreed re-run inside its own objection window');
    assert.equal(closed.state, 'FINAL', closed.why);
    assert.match(closed.why, /re-run by 5 of 7 committee signer nodes: the replay outcome is authoritative/);
  } finally { await w.close(); }
});

// A SECOND VALID OBJECTION INSIDE THE RE-RUN'S OWN WINDOW VOIDS THE ENTRY (§13A, RULED the owner 2026-09-24, slice C2b).
// Five of the other six keys re-run the objected result to another score, so the re-run is agreed at 5 of 7 without the
// holder, whose own re-run keeps the old score: a second objection holds here. Filed inside agreed + W, the entry is VOID
// at once - no third run - and the VOID goes the suspended entry's way to the money.
async function agreedWithoutTheHolder(w) {
  const s = await suspended(w);
  assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
  w.rerunBy('dissents', 5, { over: { score: s.replay.score + 2 } });
  const agreeing = w.holder.round.reruns(w.rid, s.eid).filter((r) => toHex(r.signerNodePubkey) !== toHex(w.holder.round.pubkey))
    .map((r) => r.seenMs).sort((a, b) => a - b);
  return { ...s, agreed: agreeing[4] };
}

test('a second valid objection inside the re-run\'s own objection window makes the entry VOID, and the VOID reaches the money', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await agreedWithoutTheHolder(w);
    assert.equal(resultFinality(at(w, s.agreed + WINDOW_MS - 1), w.rid, s.eid).state, 'PROVISIONALLY_FINAL');
    const second = await object(w, s.eid);
    assert.equal(second.status, 201, `the second objection was not taken: ${await second.text()}`);
    const filedSecond = w.holder.round.rerunObjectedAt(w.rid, s.eid);
    const inside = resultFinality(at(w, s.agreed + WINDOW_MS - 1), w.rid, s.eid);
    const closed = resultFinality(at(w, s.agreed + WINDOW_MS), w.rid, s.eid);
    const threeLater = resultFinality(at(w, s.filed + 3 * WINDOW_MS), w.rid, s.eid);
    const edge = s.agreed + WINDOW_MS - 1;
    const released = new (w.holder.preimages.constructor)(at(w, edge), {}).mayRelease(w.rid, s.eid);
    const onRecord = new LockSettlement(at(w, edge, { stakeSeen: (eid) => toHex(eid) === toHex(s.eid) }), {}).entriesOnRecord(w.rid, null);
    const forfeit = await new Forfeit(at(w, edge, { stakeLock: () => ({ fields: {} }) }), {}).message(w.rid, s.eid);
    console.log('  FACTS:', JSON.stringify({ agreedAfterFiling: s.agreed - s.filed, secondAfterAgreed: filedSecond - s.agreed,
      inside: inside.state, closed: closed.state, threeLater: threeLater.state, released: released.ok,
      table: onRecord.ok ? onRecord.entries.map((e) => `${e.outcome}/${e.score}`) : onRecord.why }), '|', inside.why);
    assert.ok(filedSecond !== null && filedSecond >= s.agreed && filedSecond < s.agreed + WINDOW_MS,
      `the second objection was stored at ${filedSecond}, not inside ${s.agreed}..${s.agreed + WINDOW_MS}`);
    assert.equal(inside.state, 'VOID', inside.why);
    assert.match(inside.why, /a second valid objection, filed at \d+ inside the agreed re-run's own objection window .* VOID, no third run \(13A\)/);
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
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), filedSecond);
  } finally { await w.close(); }
});

// AND OUTSIDE IT: a second objection at the re-run's window close is not counted, and the intake takes none (C2b).
test('a second objection at the re-run\'s window close counts for nothing, and the intake answers 409 and stores nothing', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await agreedWithoutTheHolder(w);
    const close = at(w, s.agreed + WINDOW_MS);
    const intake = objectionIntake(close, w.rid, s.eid);
    assert.deepEqual(intake, { status: 409, text: 'the re-run\'s objection window has closed' });
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null, 'the intake stored an objection after the window');
    assert.equal(close.objectRerun(w.rid, s.eid), true);                  // written straight to the store at the close
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), s.agreed + WINDOW_MS);
    const read = resultFinality(close, w.rid, s.eid);
    assert.equal(read.state, 'FINAL', read.why);
  } finally { await w.close(); }
});

// THE INTAKE'S REJECTS (C2b): while the run is still SUSPENDED an objection is the first one again; a missing entry or a
// round the entry is not in is 404, and this entry is unchanged.
test('while SUSPENDED an objection is the first again, and a missing or foreign entry is 404 with this entry unchanged', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    const again = await object(w, s.eid);
    assert.equal(again.status, 200);
    assert.equal((await again.text()).trim(), 'already objected');
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null, 'an objection while SUSPENDED was stored as the second');
    const missing = await fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(w.rid)}&entry=${toHex(rand(32))}`, { method: 'POST' });
    assert.equal(missing.status, 404);
    const foreign = await fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(rand(32))}&entry=${toHex(s.eid)}`, { method: 'POST' });
    assert.equal(foreign.status, 404);
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, s.eid), null);
    assert.equal(w.holder.round.objectedAt(w.rid, s.eid), s.filed);
    assert.equal(resultFinality(at(w, s.filed + 1), w.rid, s.eid).state, 'SUSPENDED');
  } finally { await w.close(); }
});

test('re-runs from keys that are not assigned, about another contradicted run, or to another outcome count for nothing', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 2);                                                           // two honest: 3 with the holder
    w.rerunBy('dissents', 2, { keys: [rand(32), rand(32)] });                           // two strangers
    w.rerunBy('dissents', 1, { keys: w.others.slice(2), contradicted: b32(0x66) });     // another contradicted run
    w.rerunBy('dissents', 1, { keys: w.others.slice(3), over: { score: s.replay.score + 2 } }); // another outcome
    const after = resultFinality(at(w, s.filed + WINDOW_MS - 1), w.rid, s.eid);   // inside the re-run window (RULED 2026-09-24)
    assert.equal(after.state, 'SUSPENDED', `strangers, another run or another outcome made five: ${after.why}`);
    assert.match(after.why, /3 of 5 committee signer nodes have re-run/);
  } finally { await w.close(); }
});
