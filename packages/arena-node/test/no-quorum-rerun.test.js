// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO QUORUM GOES TO THE RE-RUN WINDOW BEFORE VOID, AND THE ROUND WAITS FOR IT (§13A, §13C, RULED 2026-11-02, kanban #1038, #1045, #1047).
//
// One real daemon on a seven-seat round of protocol 22, the other six keys the test holds: results, re-runs, postings and FINAL signatures are theirs, the finality, the
// watch and the table are the daemon's. The rule's money is measured on two running seats in no-quorum-rerun-money.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { object } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { settleWaitsOn } from '../src/server.js';
import { NO_QUORUM_FINAL_GRACE_MS } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seven, win, stateOf, until, signRun, results, noQuorumAt, rerunsIn, tableOf, finalOnRerun } from './no-quorum-fixture.js';

test('4 of 7 at final_after is SUSPENDED, not VOID: the round waits, the holder re-runs by itself, a quorum in the window gets its objection window, and the table reads the re-run', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    const eid = await noQuorumAt(w);
    const first = stateOf(w, eid);
    assert.equal(first.state, 'SUSPENDED', first.why);
    assert.equal(first.noQuorumRerun, true);
    assert.equal(first.holdsRound, true);
    assert.equal(w.holder.round.noQuorum(eid), null, 'written at final_after');
    assert.deepEqual(settleWaitsOn([{ state: first.state, holdsRound: first.holdsRound, rerun: first.rerun }]).length, 1);
    const held = tableOf(w);
    assert.equal(held.ok, false);
    assert.match(held.why, /no lock is claimed while an entry with no quorum is being decided/);
    // THE HOLDER'S WATCH SIGNS ITS OWN RE-RUN, NAMING NO RUN
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w);
    const agreed = stateOf(w, eid);
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    assert.equal(agreed.rerun.agreed, 5);
    assert.equal(agreed.holdsRound, true);
    assert.equal(agreed.contradictedRunId, undefined, 'a no-quorum re-run contradicts nobody');
    assert.equal(Number(agreed.closesAtMs), win(w).ownCloseMs);
    w.post('dissents');
    const f = await finalOnRerun(w, eid);
    console.log('  FACTS (4 of 7, then a quorum in the window):', JSON.stringify({ first: first.state, agreed: agreed.state, end: f.state, why: f.why }));
    assert.equal(f.state, 'FINAL', f.why);
    assert.equal(f.holdsRound, undefined);
    assert.equal(w.holder.round.slashProofs(w.rid, eid).length, 0, 'a slash proof was filed with no objection on record');
  } finally { await w.close(); }
});

test('no quorum in the window: VOID at end + 1205 s, written once, and it no longer holds the round; a late re-run counts for nothing', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    const eid = await noQuorumAt(w);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w, 3);
    const inWindow = stateOf(w, eid);
    assert.equal(inWindow.state, 'SUSPENDED', inWindow.why);
    assert.equal(inWindow.rerun.agreed, 4);
    skipTo(win(w).rerunDeadlineMs + 50);
    assert.ok(await until(() => !!w.holder.round.noQuorum(eid)), 'the watch wrote no outcome at the window\'s end');
    const held = w.holder.round.noQuorum(eid);
    console.log('  FACTS (4 of 7, 4 re-runs):', held.outcome, held.why);
    assert.equal(held.outcome, 'VOID');
    rerunsIn(w, 5, { keys: w.others.slice(3) });                               // too late to count, and a written decision stands
    assert.equal(stateOf(w, eid).state, 'VOID');
    assert.equal(stateOf(w, eid).holdsRound, undefined);
  } finally { await w.close(); }
});

test('proven equivocation is FORFEIT at once at final_after, not at the window\'s end', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    const eid = results(w, 'dissents', 3);
    const said = await (await import('./window-fixture.js')).say(w.holder.port, w.runs.dissents.otherFirstMark());
    assert.notEqual(said.length, 0);
    skipTo(win(w).finalAfterMs + 50);
    const f = stateOf(w, eid);
    console.log('  FACTS (4 of 7, two first marks):', JSON.stringify({ state: f.state, why: f.why }));
    assert.equal(f.state, 'FORFEIT', f.why);
    assert.equal(w.holder.round.noQuorum(eid).outcome, 'FORFEIT');
  } finally { await w.close(); }
});

test('an entry suspended by an objection does not hold the round: it stays left out', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    signRun(w, 'dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    assert.equal((await object(w, eid)).status, 201);
    skipTo(win(w).finalAfterMs + 50);
    const f = stateOf(w, eid);
    assert.equal(f.state, 'SUSPENDED', f.why);
    assert.equal(f.holdsRound, undefined);
    assert.equal(f.noQuorumRerun, undefined);
    await w.finalBy('agrees', 5);
    const t = tableOf(w);
    assert.equal(t.ok, true, t.why);
    assert.deepEqual(t.leftOut.map((x) => toHex(x.entryId)), [toHex(eid)]);
  } finally { await w.close(); }
});

test('an in-time quorum short of its postings goes to the window too: postings and a re-run inside it, FINAL; the same run posted too late, VOID', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    signRun(w, 'dissents', () => ({}), { posted: false });
    w.post('dissents', 3);                                                      // 3 of the 5 it needs
    const eid = w.runs.dissents.eid;
    skipTo(win(w).finalAfterMs + 50);
    const short = stateOf(w, eid);
    assert.equal(short.state, 'SUSPENDED', short.why);
    assert.equal(short.unpublished, true);
    assert.equal(short.holdsRound, true);
    assert.equal(w.holder.round.noQuorum(eid), null);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w);
    assert.equal(stateOf(w, eid).state, 'PROVISIONALLY_FINAL');
    skipTo(win(w).rerunDeadlineMs + 50);                                        // the window's end, the postings still short
    const late = stateOf(w, eid);
    console.log('  FACTS (quorum short of postings to the window\'s end):', JSON.stringify({ short: short.state, late: late.state, why: late.why }));
    assert.equal(late.state, 'VOID', late.why);
    assert.ok(await until(() => !!w.holder.round.noQuorum(eid)), 'the watch wrote no outcome');
    w.post('dissents', 5);
    assert.equal(stateOf(w, eid).state, 'VOID', 'a posting past the deadline turned it back');
  } finally { await w.close(); }
});

test('a seat short of postings while five others signed FINAL takes their signatures: FINAL, not the window', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    signRun(w, 'dissents', () => ({}), { posted: false });
    const eid = w.runs.dissents.eid;
    skipTo(win(w).finalAfterMs + 50);
    assert.equal(stateOf(w, eid).state, 'SUSPENDED');
    const said = await w.finalBy('dissents', 5, { run: w.runs.dissents.contradicted });
    assert.deepEqual([...new Set(said)], ['201 kept'], said[0]);
    assert.equal(stateOf(w, eid).state, 'FINAL', stateOf(w, eid).why);
  } finally { await w.close(); }
});

test('postings in the window: the same run is FINAL after its own objection window', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    signRun(w, 'dissents', () => ({}), { posted: false });
    const eid = w.runs.dissents.eid;
    skipTo(win(w).finalAfterMs + 50);
    assert.equal(stateOf(w, eid).state, 'SUSPENDED');
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w);
    w.post('dissents', 5);
    const f = await finalOnRerun(w, eid);
    assert.equal(f.state, 'FINAL', f.why);
  } finally { await w.close(); }
});

test('an agreed re-run short of its FINAL signatures past the bound no longer holds the round', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    const eid = await noQuorumAt(w);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w);
    w.post('dissents', 5);
    skipTo(win(w).ownFinalAfterMs + 10);
    assert.equal(stateOf(w, eid).holdsRound, true);
    skipTo(win(w).ownFinalAfterMs + Number(NO_QUORUM_FINAL_GRACE_MS) + 10);
    const f = stateOf(w, eid);
    assert.equal(f.state, 'PROVISIONALLY_FINAL');
    assert.equal(f.holdsRound, false);
  } finally { await w.close(); }
});

test('a valid objection to the agreed re-run is the entry\'s one objection: VOID, as a second objection is, and nothing is filed against a first result', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    const eid = await noQuorumAt(w);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    rerunsIn(w, 4, { keys: w.others.slice(1), over: { score: 77 } });           // five of the six... signed another score: the holder's own replay differs
    rerunsIn(w, 1, { over: { score: 77 } });
    const agreed = stateOf(w, eid);
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    const said = await object(w, eid);
    assert.equal(said.status, 201, await said.clone().text());
    const f = stateOf(w, eid);
    console.log('  FACTS (objection to the re-run):', JSON.stringify({ state: f.state, why: f.why }));
    assert.equal(f.state, 'VOID', f.why);
    assert.equal(f.secondObjection, true);
    assert.equal(w.holder.round.objected(w.rid, eid), false, 'it was stored as a first objection');
    assert.equal(w.holder.round.slashProofs(w.rid, eid).length, 0);
  } finally { await w.close(); }
});
