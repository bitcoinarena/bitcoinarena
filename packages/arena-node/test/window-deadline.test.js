// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RESULT WINDOW'S DEADLINE (§13A "Results must be in before the window closes ... one that has not by window_close falls
// to §13C's no-quorum rule"; "Publication is a condition of finality ... within the window"; §13CRULED the owner
// 2026-10-04). The deadline is final_after - the round's end + 600 s + 5 s, wall-clock ms - on the seat's own clock, by when
// it held each record. Seven seats (the holder and six keys the test holds), the fixtures' clock skipped:
//   (a) the 5th matching result held after the deadline: VOID, the reason naming that late arrival; all 5 in time: FINAL;
//   (b) the posting that completes the threshold held after the deadline: VOID; in time: FINAL;
//   (c) a 4-3 split with all seven up: VOID once, no FINAL; the same with a proven equivocation: FORFEIT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes, WINDOW_MS, say } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { runId } from '../src/verdict.js';

const seven = () => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });
const stateOf = (w, name) => resultFinality(w.holder.round, w.rid, w.runs[name].eid);
const deadline = (w) => Number(windowsOf(w.contract).finalAfterMs);
/** The run the holder itself signed for `name` - what the other seats would sign FINAL on. */
const ownRun = (w, name) => runId(decodePlayerResult(splitSignedResult(w.holder.round.results(w.rid, w.runs[name].eid)
  .find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey)).bytes).body));

/** `keys` of the six sign `name`'s run as the holder replayed it, changed by `rewrite`; held now, on the holder's clock. */
function signBy(w, name, keys, rewrite = () => ({})) {
  const eid = w.runs[name].eid;
  const mine = w.holder.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
  const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
  for (const secret of keys) {
    const r = { ...shape, ...rewrite(shape), nodePubkey: schnorr.getPublicKey(secret) };
    const id = resultId(r);
    w.holder.round.putResult(w.rid, eid, r.nodePubkey, id, joinSignedResult(encodePlayerResult(r), schnorr.sign(id, secret)));
  }
}

test('(a) the 5th matching result held after the deadline is VOID, its reason naming the late arrival; all five in time is FINAL', async () => {
  const w = await seven();
  try {
    // 'agrees': the holder and three seats in time - 4 of 5 - and the posting threshold in time
    signBy(w, 'agrees', w.others.slice(0, 3));
    w.post('agrees', 5);
    // 'dissents' (here simply the second run): the holder and four seats in time, posted - the contrast
    signBy(w, 'dissents', w.others.slice(0, 4));
    w.post('dissents', 5);
    skipTo(deadline(w) + 1000);
    signBy(w, 'agrees', w.others.slice(3, 4));                  // the 5th matching result, held after the deadline
    const late = stateOf(w, 'agrees');
    const again = stateOf(w, 'agrees');
    const lateFinalSigs = await w.finalBy('agrees', 6, { run: ownRun(w, 'agrees') });
    const afterFinalSigs = stateOf(w, 'agrees');
    const contrast = await w.finalNow('dissents');
    console.log('  FACTS (a):', JSON.stringify({ late: { state: late.state, why: late.why }, again: again.state, lateFinalSigs: lateFinalSigs.slice(0, 2),
      afterFinalSigs: afterFinalSigs.state, contrast: { state: contrast.state, why: contrast.why } }));
    assert.equal(late.state, 'VOID', late.why);
    assert.equal(late.noQuorum, true);
    assert.match(late.why, /^no result at the threshold by .* \(the round's end \+ 600 s \+ 5 s\): 4 of 5 matching results held in time; the matching result that completed the threshold \(5 of 5\) reached this seat at .*, after the result window's deadline - .* \(§13C\)$/);
    assert.equal(again.state, 'VOID');
    assert.equal(w.holder.round.noQuorum(w.runs.agrees.eid).outcome, 'VOID', 'the decision was not written');
    assert.equal(afterFinalSigs.state, 'VOID', 'FINAL signatures arriving later turned a VOID back');
    assert.equal(contrast.state, 'FINAL', contrast.why);
  } finally { await w.close(); }
});

test('(b) the posting that completes the threshold held after the deadline is VOID; postings in time are FINAL', async () => {
  const w = await seven();
  try {
    signBy(w, 'agrees', w.others.slice(0, 4));
    signBy(w, 'dissents', w.others.slice(0, 4));
    // 'agrees': three of the six post in time (with the holder's own, if it posted, still short of five when it did not)
    const posted = (name) => w.holder.round.postings(w.rid, w.runs[name].eid).length;
    w.post('agrees', 3);
    const heldInTime = posted('agrees');
    w.post('dissents', 5);
    skipTo(deadline(w) + 1000);
    // the rest post now - after the deadline
    w.post('agrees', 6);
    const late = stateOf(w, 'agrees');
    await w.finalBy('agrees', 6, { run: ownRun(w, 'agrees') });
    const after = stateOf(w, 'agrees');
    const contrast = await w.finalNow('dissents');
    console.log('  FACTS (b):', JSON.stringify({ heldInTime, heldAfter: posted('agrees'), late: { state: late.state, why: late.why }, after: after.state,
      contrast: { state: contrast.state, why: contrast.why } }));
    assert.ok(heldInTime < 5, `the test posted ${heldInTime} in time: not the case it names`);
    assert.equal(late.state, 'VOID', late.why);
    assert.match(late.why, /^the transcript was not published by the settlement threshold by .*: \d of 5 postings held in time; the posting that completed the threshold reached this seat at .*, after the result window's deadline - a seat that cannot retrieve the transcript within the result window treats the entry as VOID \(§13A, §13C\)$/);
    assert.equal(after.state, 'VOID', 'FINAL signatures after a late posting turned a VOID back');
    assert.equal(contrast.state, 'FINAL', contrast.why);
  } finally { await w.close(); }
});

test('(c) a 4-3 split with all seven up is VOID once, no FINAL; with a proven equivocation it is FORFEIT', async () => {
  const w = await seven();
  try {
    // 'agrees': the holder and three seats on its run, the other three on another (score + 1) - all in time, all up
    signBy(w, 'agrees', w.others.slice(0, 3));
    signBy(w, 'agrees', w.others.slice(3, 6), (r) => ({ score: r.score + 1 }));
    // 'dissents': the same split, and the player's second first mark held - §13B's proof of equivocation
    signBy(w, 'dissents', w.others.slice(0, 3));
    signBy(w, 'dissents', w.others.slice(3, 6), (r) => ({ score: r.score + 1 }));
    const pairBefore = w.holder.round.provenTwoFirstMarks(w.rid, w.runs.dissents.eid) === true;
    const proof = await say(w.holder.port, w.runs.dissents.otherFirstMark());
    const pairAfter = w.holder.round.provenTwoFirstMarks(w.rid, w.runs.dissents.eid) === true;
    const before = stateOf(w, 'agrees');
    skipTo(deadline(w) + 1000);
    const split = stateOf(w, 'agrees');
    const twice = stateOf(w, 'agrees');
    const fin = await w.finalBy('agrees', 6, { run: ownRun(w, 'agrees') });
    const after = stateOf(w, 'agrees');
    const forfeit = stateOf(w, 'dissents');
    console.log('  FACTS (c):', JSON.stringify({ before: before.state, split: { state: split.state, why: split.why }, twice: twice.state,
      finalSigs: fin.slice(0, 2), after: after.state, proof: String(proof).slice(0, 60), pairBefore, pairAfter, forfeit: { state: forfeit.state, why: forfeit.why } }));
    assert.equal(before.state, null, `before the deadline a split waits: ${before.why}`);
    assert.equal(split.state, 'VOID', split.why);
    assert.match(split.why, /^no result at the threshold by .*: 4 of 5 matching results held in time - .* \(§13C\)$/);
    assert.equal(twice.state, 'VOID');
    assert.equal(after.state, 'VOID', 'a split turned FINAL');
    assert.equal(pairBefore, false, 'a pair was held before the second first mark: not the case the test names');
    assert.equal(pairAfter, true, 'the second first mark was not held as a proof');
    assert.equal(forfeit.state, 'FORFEIT', forfeit.why);
  } finally { await w.close(); }
});
