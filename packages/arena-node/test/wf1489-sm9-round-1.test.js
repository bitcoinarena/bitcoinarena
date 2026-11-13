// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE MACHINE AUDIT 9, ROUND (kanban #1489): an objection that reached this seat before final_after, whose check is still running when the
// seat's clock passes final_after, must have the same effect as one whose check answered sooner. finalityStep (#1173) holds the entry
// SUSPENDED while the check runs only when the evidence reads FINAL or signable; the §13C VOID that computeFinality writes once
// (putNoQuorum, "transcript not published in time") is written anyway. When the check then holds, the objection is taken as in time, the
// entry reads SUSPENDED and goes to its re-run - and the seat ALSO holds a no-quorum VOID for good, which the settlement (entriesOnRecord),
// the finality watch (decidedHere) and the restart pick-up read first. A seat whose check answered before final_after holds no VOID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipTo, testNow } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { resultFinality } from '../src/finality.js';
import { withPendingObjection, objectionIntake } from '../src/server.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CLOCK } from './block-clock.js';
import { sevenSignerNodes, WINDOW_MS, objectionBundleFor } from './window-fixture.js';

test('wf1489-sm9-round-1: an in-time objection still being checked at final_after leaves a no-quorum VOID beside the SUSPENDED entry', async () => {
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });
  try {
    // five of seven sign a run this seat replayed differently; its transcript is not posted in time
    w.sign('dissents', (r) => ({ score: r.score + 1 }), { posted: false });
    const round = w.holder.round;
    const eid = w.runs.dissents.eid;
    const win = windowsOf(w.contract);
    const { bundle } = await objectionBundleFor(w, eid);
    const block = CLOCK.tipAt(Date.now());
    const arrived = round.now();
    assert.ok(BigInt(arrived) < win.finalAfterMs, 'the objection arrives inside the window');
    const f0 = resultFinality(round, w.rid, eid);
    const against = typeof f0.runId === 'string' ? Uint8Array.from(Buffer.from(f0.runId, 'hex')) : f0.runId;
    // THE DOOR'S ORDER (POST /objection): arrival kept as pending, then the check (its replay); a loaded seat's check ends after final_after,
    // and meanwhile the finality watch reads the entry, as it does every tick
    let midway = null;
    const taken = await withPendingObjection(round, w.rid, eid, arrived, async () => {
      skipTo(Number(win.finalAfterMs) + 200);
      midway = resultFinality(round, w.rid, eid);
      const c = await w.holder.verifier.checkObjection(w.rid, eid, bundle, against);
      return c.holds ? { ...c, taken: objectionIntake(round, w.rid, eid, block, bundle, arrived) } : c;
    });
    const after = resultFinality(round, w.rid, eid);
    const nq = round.noQuorum(eid);
    console.log(`wf1489-sm9-round-1: objection arrived ${arrived} < final_after ${win.finalAfterMs}; while checked: ${midway.state}`
      + `${midway.pendingObjection ? ' (pending)' : ''}; check holds=${taken.holds} taken=${taken.taken && taken.taken.status}; after: ${after.state}; `
      + `no-quorum record: ${nq ? `${nq.outcome} (${String(nq.why).slice(0, 90)})` : 'none'}`);
    assert.equal(taken.holds, true, `the objection did not hold: ${taken.why}`);
    assert.equal(taken.taken.status, 201);
    assert.equal(round.objectedAt(w.rid, eid), arrived, 'stored as in time');
    assert.equal(after.state, 'SUSPENDED', after.why);
    // THE INVARIANT: an objection in time decides the entry by its re-run, not by a VOID written while its check ran
    assert.equal(nq, null, `the seat holds a no-quorum ${nq && nq.outcome} for an entry an in-time objection suspends: settlement reads ${nq && nq.outcome} while the re-run decides it elsewhere`);
    assert.notEqual(midway.state, 'VOID', 'decided VOID while an in-time objection was still being checked');
  } finally { await w.close(); }
});
