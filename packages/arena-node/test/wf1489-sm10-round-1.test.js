// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, state-machine audit round 10 (area: round). A SUSPENDED entry whose re-run window closes short of the threshold is
// §13C's: VOID (or FORFEIT on a proven equivocation). Every other §13C door in finality.js writes its decision once (putNoQuorum), so
// "evidence that reaches it later does not turn a VOID into a FORFEIT" - the SUSPENDED branch returns the outcome and writes nothing.
// So (a) the seat holds no decision record: decidedHere / resumingCloses read the entry as still short of FINAL for good, and
// (b) a proof of two first marks pulled after the deadline (its marks recorded before it, by a peer, with the peer's time)
// turns the VOID this seat already read - and settled on - into a FORFEIT: the stake goes to the pool instead of back to the player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { resultFinality } from '../src/finality.js';
import { decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { testNow } from './test-clock.js';
import { wait, sevenSignerNodes, object, WINDOW_MS } from './window-fixture.js';

const seven = (o = {}) => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, ...o });
const winOf = (w) => { const x = windowsOf(w.contract); return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number(v)])); };
const at = (w, now, over = {}) => Object.assign(Object.create(w.holder.round), { now: () => now }, over);
async function holdersRerun(w, eid, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const own = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey));
    if (own) return decodeRerunResult(splitSignedRerun(own.bytes).body);
    await wait(50);
  }
  return null;
}

test('wf1489-sm10-round-1: a §13C VOID at the end of the re-run window is written once and later evidence does not turn it into a FORFEIT', async () => {
  const w = await seven();
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    assert.equal((await object(w, eid)).status, 201);
    assert.ok(await holdersRerun(w, eid), 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 3);                                   // 4 of 5 re-runs: no threshold
    const win = winOf(w);
    // THE SEAT DECIDES AT ITS OWN CLOCK, at the re-run window's end (end + 1205 s)
    const decided = resultFinality(at(w, win.rerunDeadlineMs), w.rid, eid);
    assert.equal(decided.state, 'VOID', decided.why);
    const record = w.holder.round.noQuorum(eid);
    // A MINUTE LATER the proof of two first marks is pulled from a peer: both marks recorded before the deadline (the peer's time),
    // so evidenceWindow counts them - the same instant's evidence, only learned later
    const later = resultFinality(at(w, win.rerunDeadlineMs + 60000, { provenTwoFirstMarks: () => true }), w.rid, eid);
    console.log('  FACTS:', JSON.stringify({ decided: decided.state, record: record ? record.outcome : null, later: later.state }));
    assert.ok(record, 'the §13C VOID decided at the re-run window\'s end is written nowhere (no no_quorum row): the seat reads the entry as undecided for good');
    assert.equal(later.state, 'VOID', `the VOID this seat decided became ${later.state} on evidence learned after the decision: ${later.why}`);
  } finally { await w.close(); }
});
