// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (sm1, area round): A COPY OF THE FIRST OBJECTION THAT WAITED IN THE ENTRY'S CHECK QUEUE IS TAKEN AS THE SECOND
// OBJECTION AGAINST THE AGREED RE-RUN, AND VOIDS AN HONEST RE-RUN.
// POST /objection reads the run it is filed against (`against`) when the request arrives, then waits in the entry's check queue (verify.js
// checkObjection: one check at a time per entry, FIFO). Two copies of the first objection (the player's own POST and a publication relay's
// relayPost, or the player's page retrying) both pass the door's "already objected" read while the first check has not answered, and both are
// checked against the FIRST signed run. While the second copy waits behind other checks (each a full replay), the first is taken, the entry is
// SUSPENDED, and the committee's re-run is agreed - on the very run the objector replayed. The waiting copy's check then holds (its replay
// contradicts the first run), and objectionIntake, seeing an agreed re-run PROVISIONALLY_FINAL, stores it with objectRerun as the second
// objection - never checked against the re-run. computeFinality counts any stored re-run objection bundle as "the replay differs", so the
// entry goes VOID: "two contradicted quorums", though the re-run agrees with the objector.
// Invariant (§13A, slice C2b): the second objection holds only if it contradicts the agreed re-run; an objection checked against the first run
// alone is never stored as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testNow } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { resultFinality } from '../src/finality.js';
import { decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { wait, sevenSignerNodes, object, objectionBundleFor, WINDOW_MS } from './window-fixture.js';

const seven = (o = {}) => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, ...o });
const at = (w, now) => Object.assign(Object.create(w.holder.round), { now: () => now });

async function holdersRerun(w, eid, ms = 15000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const own = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey));
    if (own) return decodeRerunResult(splitSignedRerun(own.bytes).body);
    await wait(50);
  }
  return null;
}

test('wf1489-sm1-round-1: a queued copy of the first objection, checked against the first run, voids the honest agreed re-run as a "second objection"', async () => {
  const w = await seven();
  try {
    // five signers sign a rewritten score; the holder's own replay contradicts it
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    const key = toHex(eid);
    const v = w.holder.verifier;
    const { bundle } = await objectionBundleFor(w, eid);          // the player's honest objection against the first run

    // ANOTHER CHECK OF THIS ENTRY IS RUNNING (any bundle the open door took: a full replay each, one at a time per entry)
    let releaseX; const x = new Promise((r) => { releaseX = r; });
    v.objectionTurns.set(key, x);
    // the player's objection and its relayed copy reach the seat together; both pass the door and queue behind it
    const first = object(w, eid, undefined, { body: bundle });
    while (v.objectionTurns.get(key) === x) await wait(5);
    // a further check queued between them (a third party's bundle replaying)
    let releaseY; const y = new Promise((r) => { releaseY = r; });
    v.objectionTurns.set(key, v.objectionTurns.get(key).then(() => y));
    const yChain = v.objectionTurns.get(key);
    const copy = object(w, eid, undefined, { body: bundle });
    while (v.objectionTurns.get(key) === yChain) await wait(5);

    releaseX();
    const r1 = await first;
    assert.equal(r1.status, 201, `the first objection was not taken: ${await r1.text()}`);
    assert.equal(resultFinality(w.holder.round, w.rid, eid).state, 'SUSPENDED');
    // the committee re-runs: the holder itself and four more, all on the holder's (the objector's) run
    const own = await holdersRerun(w, eid);
    assert.ok(own, 'the holder never re-ran the suspended result');
    w.rerunBy('dissents', 4);
    const agreed = resultFinality(w.holder.round, w.rid, eid);
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    assert.ok(agreed.rerun && agreed.rerun.runId, 'no agreed re-run');

    // the queued copy now gets its turn
    releaseY();
    const r2 = await copy;
    const r2text = (await r2.text()).trim();
    const own2 = windowsOf(w.contract).ownFinalAfterMs;
    const inside = resultFinality(at(w, Number(own2) - 1), w.rid, eid);
    console.log('  FACTS:', JSON.stringify({ copy: `${r2.status} ${r2text}`, rerunObjectedAt: w.holder.round.rerunObjectedAt(w.rid, eid),
      rerunRun: agreed.rerun.runId.slice(0, 16), state: inside.state }), '|', inside.why);
    assert.equal(w.holder.round.rerunObjectedAt(w.rid, eid), null,
      'a copy of the first objection, checked against the first run only, was stored as the second objection against the agreed re-run');
    assert.notEqual(inside.state, 'VOID', `an honest agreed re-run (the objector's own run) was voided: ${inside.why}`);
  } finally { await w.close(); }
});
