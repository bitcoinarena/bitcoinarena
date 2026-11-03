// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND WAITS IF A SEAT HOLDS A RUN OF THE ENTRY: A SIGNED RESULT OR A RECEIPTED MARK (§13A, §13C, RULED 2026-11-02, kanban #1060). No mark at all is VOID at final_after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { wait } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { seven, win, stateOf, until, signRun, noQuorumAt, tableOf, withoutResults, withoutMarks, rerunsLike } from './no-quorum-fixture.js';

test('nobody signed, a receipted mark held: the round waits and a seat coming back completes the five (ruling #1060)', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    const { eid, back } = withoutResults(w, 'dissents');
    skipTo(win(w).finalAfterMs + 50);
    await w.finalBy('agrees', 5);
    const first = stateOf(w, eid);
    console.log('  FACTS (no result, own receipts):', JSON.stringify({ state: first.state, why: first.why }));
    assert.equal(first.state, 'SUSPENDED', first.why);
    assert.equal(first.noQuorumRerun, true);
    assert.equal(first.holdsRound, true);
    assert.equal(w.holder.round.noQuorum(eid), null, 'written at final_after');
    assert.match(tableOf(w).why, /no lock is claimed while an entry with no quorum is being decided/);
    const said = await w.holder.verifier.retryClose(w.rid, eid);
    assert.equal(said.decided, undefined, 'the door decided a run at final_after');
    assert.equal(w.holder.round.noQuorum(eid), null, 'written at the door');
    await wait(500);
    assert.equal(w.holder.round.reruns(w.rid, eid).length, 0, 'signed a re-run with no transcript');
    back();
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the seat did not re-run once the receipts were there');
    rerunsLike(w, eid, 4, testNow());
    const agreed = stateOf(w, eid);
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    assert.equal(agreed.rerun.agreed, 5);
  } finally { await w.close(); }
});

test('no re-run over a prefix: a first mark with its 5 receipts, the next mark short, and seats out who could lengthen it', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    const { eid, back } = withoutResults(w, 'dissents');
    // THE FIXTURE'S RUN HAS ONE MARK, SO ITS CANONICAL PREFIX IS STOOD IN FOR: a transcript answers, and the mark after it is short of its receipts, as on seven real seats
    const canonical = w.holder.round.canonicalTranscript;
    w.holder.round.canonicalTranscript = () => ({ marks: [], batches: [] });
    skipTo(win(w).finalAfterMs + 50);
    await w.finalBy('agrees', 5);
    await wait(1000);
    assert.equal(stateOf(w, eid).state, 'SUSPENDED');
    assert.equal(w.holder.round.reruns(w.rid, eid).length, 0, 'it signed a re-run over the prefix');
    w.holder.round.canonicalTranscript = canonical;
    back();
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'it did not re-run once the receipts were there');
  } finally { await w.close(); }
});

test('nobody signed and no fifth receipt: VOID at the window\'s end, not at final_after', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    const { eid } = withoutResults(w, 'dissents');
    skipTo(win(w).finalAfterMs + 50);
    await w.holder.verifier.retryClose(w.rid, eid);
    assert.equal(w.holder.round.noQuorum(eid), null);
    skipTo(win(w).rerunDeadlineMs + 50);
    assert.equal(stateOf(w, eid).state, 'VOID');
    await w.holder.verifier.retryClose(w.rid, eid);
    assert.ok(await until(() => !!w.holder.round.noQuorum(eid)), 'nothing wrote the outcome');
    assert.equal(w.holder.round.noQuorum(eid).outcome, 'VOID');
    assert.equal(stateOf(w, eid).holdsRound, undefined);
  } finally { await w.close(); }
});

test('no mark at all: VOID at final_after, and it holds nothing', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    const eid = withoutMarks(w, 'dissents');
    skipTo(win(w).finalAfterMs + 50);
    await w.finalBy('agrees', 5);
    const r = await w.holder.verifier.retryClose(w.rid, eid);
    console.log('  FACTS (no mark):', JSON.stringify({ decided: r.decided, why: r.why }));
    assert.equal(r.decided, 'VOID', r.why);
    const f = stateOf(w, eid);
    assert.equal(f.state, 'VOID');
    assert.equal(f.holdsRound, undefined);
    assert.equal(tableOf(w).ok, true, tableOf(w).why);
  } finally { await w.close(); }
});

test('no mark here, a peer holding receipts of the entry: that is a run, and the door holds to the window\'s end', { timeout: 110000 }, async () => {
  const peer = createServer((req, res) => {
    if (req.url.startsWith('/receipts')) { res.writeHead(200); res.end(Buffer.alloc(SIGNED_RECEIPT_BYTES, 7)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => peer.listen(0, '127.0.0.1', ok));
  const w = await seven({ peers: [`http://127.0.0.1:${peer.address().port}`] });
  try {
    signRun(w, 'agrees', () => ({}));
    const eid = withoutMarks(w, 'dissents');
    skipTo(win(w).finalAfterMs + 50);
    const r = await w.holder.verifier.retryClose(w.rid, eid);
    assert.equal(r.decided, undefined, r.why);
    assert.equal(w.holder.round.noQuorum(eid), null);
    skipTo(win(w).rerunDeadlineMs + 50);
    const end = await w.holder.verifier.retryClose(w.rid, eid);
    assert.equal(end.decided, 'VOID', end.why);
  } finally { await w.close(); peer.close(); peer.closeAllConnections(); }
});

test('a seat out through the window\'s end takes five re-runs signed inside it and their FINAL signatures, and signs none; four, or a fifth signed too late, stay VOID', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    const eid = await noQuorumAt(w);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    const insideMs = win(w).rerunDeadlineMs - 2000;
    skipTo(win(w).rerunDeadlineMs + 50);
    rerunsLike(w, eid, 3, insideMs);                                            // the holder's and three: four
    rerunsLike(w, eid, 1, win(w).rerunDeadlineMs + 40, w.others.slice(3));
    assert.equal(stateOf(w, eid).state, 'VOID');
    rerunsLike(w, eid, 1, insideMs, w.others.slice(4));                          // the fifth signed inside it
    const heard = stateOf(w, eid);
    console.log('  FACTS (a seat out at the window\'s end):', JSON.stringify({ state: heard.state, why: heard.why }));
    assert.equal(heard.state, 'PROVISIONALLY_FINAL', heard.why);
    assert.equal(heard.signable, undefined);
    assert.ok(heard.askFinalOn);
    skipTo(win(w).ownFinalAfterMs + 50);
    assert.equal((await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?round=${toHex(w.rid)}&entry=${toHex(eid)}`)).status === 200, false, 'it signed FINAL on a window it was out for');
    const said = await w.finalBy('dissents', 5, { run: heard.askFinalOn, keys: [...w.others.slice(0, 3), ...w.others.slice(4)] });
    assert.deepEqual([...new Set(said)], ['201 kept'], said[0]);
    const f = stateOf(w, eid);
    assert.equal(f.state, 'FINAL', f.why);
    assert.ok(f.rerunResult);
    assert.equal(w.holder.round.noQuorum(eid), null);
  } finally { await w.close(); }
});

test('a seat that asked for FINAL all through the window signs as soon as it may: the wait does not carry past its own final_after', { timeout: 110000 }, async () => {
  const w = await seven();
  try {
    signRun(w, 'agrees', () => ({}));
    signRun(w, 'dissents', () => ({}), { posted: false });
    const eid = w.runs.dissents.eid;
    skipTo(win(w).finalAfterMs + 50);
    await w.finalBy('agrees', 5);
    assert.ok(await until(() => w.holder.round.reruns(w.rid, eid).length === 1), 'the holder did not re-run the entry');
    const agreed = () => { const x = decodeRerunResult(splitSignedRerun(w.holder.round.reruns(w.rid, eid)[0].bytes).body); return x; };
    rerunsLike(w, eid, 4, testNow());
    w.post('dissents', 5);
    assert.equal(stateOf(w, eid).state, 'PROVISIONALLY_FINAL');
    assert.ok(stateOf(w, eid).askFinalOn);
    await wait(8000);                                                            // the watch has asked and backed off by now
    skipTo(win(w).ownFinalAfterMs + 50);
    const run = stateOf(w, eid).signable.runId;
    const mine = () => w.holder.round.finalSigs(w.rid, eid, run).some((r) => toHex(r.signerPubkey) === toHex(w.holder.round.pubkey));
    assert.equal(agreed().contradictedRunId.every((b) => b === 0), true);
    const t0 = Date.now();
    assert.ok(await until(mine, 3000), 'its own FINAL waited on the back-off');
    console.log('  FACTS (own FINAL after its window):', Date.now() - t0, 'ms');
  } finally { await w.close(); }
});
