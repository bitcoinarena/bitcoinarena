// A SUSPENDED RESULT AND THE COMMITTEE'S RE-RUN (v4.6.2 §13A).
//
// "A valid objection suspends finality. The full committee re-runs the
// canonical transcript; the replay outcome is authoritative. Every node that
// signed the contradicted result is slashed (§5A.3). If the committee cannot
// reach 5-of-7 on the re-run, §13C applies."
//
// THE FIXTURE, measured before (TASKBOOK, 2f01ea1): seven seats (the holder and
// six keys), five sign a result with the score rewritten, the holder's own
// replay contradicts it, an objection is filed inside an 800 ms window - and
// two windows later the run was still SUSPENDED, no share released, 0 re-run
// results, because the node had no re-run.
//
// Now the holder re-runs by itself when the objection holds, the other seats'
// re-runs are counted, and 5 of 7 on one outcome replace SUSPENDED. Short of
// that it stays SUSPENDED: 13C is timed from the result window, which the
// contract does not carry yet (PRIORITIES, parked).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { runOf, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { toHex } from '../../protocol/src/hash.js';
import { b32, rand, wait, sevenSeats, object, WINNER } from './window-fixture.js';

/** Wait until the holder has signed its own re-run of `eid`, and return it. */
async function holdersRerun(w, eid, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const own = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.seatPubkey) === toHex(w.holder.round.pubkey));
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
  return { eid, replay: decodePlayerResult(splitSignedResult(mine.bytes).body), filedAt: Date.now() };
}

test('the committee re-runs a suspended result: the holder re-runs by itself, four seats agree, and two windows later the re-run\'s outcome is FINAL and its share is released', async () => {
  const w = await sevenSeats(800);
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    await wait(Math.max(0, s.filedAt + 1700 - Date.now()));      // two windows, as measured before
    const after = resultFinality(w.holder.round, w.rid, s.eid);
    const may = w.holder.preimages.mayRelease(w.rid, s.eid);
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
    console.log('  FACTS (7 seats, contradicted result, re-run 5 of 7):', JSON.stringify(facts), '|', after.why);
    assert.deepEqual(facts, {
      suspendedByTheObjection: 'SUSPENDED', holderReranItsReplay: true, holderNamedTheContradictedRun: true,
      reruns: 5, after: 'FINAL', authoritativeRun: true, shareReleased: true, outcome: 'FAILED',
    });
    assert.match(after.why, /re-run by 5 of 7 committee seats: the replay outcome is authoritative/);
  } finally { await w.close(); }
});

// AN OBJECTED STOPPED RUN (M3.3-34 walk-away step 7): the winner's checkpoints
// cease at tick 600 while its run is still LIVE, so the close ends it FAILED at
// its last receipted checkpoint (§15, ruled 2026-09-12). Five seats sign it with
// the score rewritten; the objection holds; the holder's own re-run must apply
// the same rule - FAILED at that checkpoint, the same score, the same run - and
// five of seven re-runs make that FINAL.
test('an objected stopped run is re-run under the same rule: FAILED at its last receipted checkpoint, the same run, FINAL at five of seven', async () => {
  const w = await sevenSeats(800, undefined, { play: { dissents: { ...WINNER, ticks: 600 } } });
  try {
    const s = await suspended(w);
    const state = resultFinality(w.holder.round, w.rid, s.eid).state;
    const own = await holdersRerun(w, s.eid);
    assert.ok(own, 'the holder never re-ran the suspended stopped run');
    w.rerunBy('dissents', 4);
    await wait(Math.max(0, s.filedAt + 1700 - Date.now()));
    const after = resultFinality(w.holder.round, w.rid, s.eid);
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

test('four re-runs are not five: two windows later the result is still SUSPENDED and no share leaves (13C, timed from the parked result window, is not applied)', async () => {
  const w = await sevenSeats(800);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);
    await wait(Math.max(0, s.filedAt + 1700 - Date.now()));
    const after = resultFinality(w.holder.round, w.rid, s.eid);
    const may = w.holder.preimages.mayRelease(w.rid, s.eid);
    assert.equal(after.state, 'SUSPENDED', `four re-runs replaced SUSPENDED: ${after.why}`);
    assert.match(after.why, /4 of 5 committee seats have re-run/);
    assert.equal(may.ok, false, 'a share left a result four seats re-ran');
    assert.match(may.why, /suspend/i);
  } finally { await w.close(); }
});

test('re-runs from keys that are not seated, about another contradicted run, or to another outcome count for nothing', async () => {
  const w = await sevenSeats(800);
  try {
    const s = await suspended(w);
    assert.ok(await holdersRerun(w, s.eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 2);                                                           // two honest: 3 with the holder
    w.rerunBy('dissents', 2, { keys: [rand(32), rand(32)] });                           // two strangers
    w.rerunBy('dissents', 1, { keys: w.others.slice(2), contradicted: b32(0x66) });     // another contradicted run
    w.rerunBy('dissents', 1, { keys: w.others.slice(3), over: { score: s.replay.score + 2 } }); // another outcome
    await wait(Math.max(0, s.filedAt + 1700 - Date.now()));
    const after = resultFinality(w.holder.round, w.rid, s.eid);
    assert.equal(after.state, 'SUSPENDED', `strangers, another run or another outcome made five: ${after.why}`);
    assert.match(after.why, /3 of 5 committee seats have re-run/);
  } finally { await w.close(); }
});
