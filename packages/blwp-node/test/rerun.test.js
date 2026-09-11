// A SUSPENDED RESULT AND THE COMMITTEE'S RE-RUN (v4.6.2 §13A).
//
// "A valid objection suspends finality. The full committee re-runs the
// canonical transcript; the replay outcome is authoritative. Every node that
// signed the contradicted result is slashed (§5A.3). If the committee cannot
// reach 5-of-7 on the re-run, §13C applies." PRIORITIES: "a SUSPENDED run has
// no committee re-run (13A) yet; it cannot happen on 2 of 2" - on seven seats
// it can: five sign a result this node's own replay contradicts.
//
// MEASURED FIRST, asserted as it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { toHex } from '../../protocol/src/hash.js';
import { wait, sevenSeats, object } from './window-fixture.js';

test('MEASURED: seven seats, five sign a result this node\'s replay contradicts, an objection holds - two windows later the run is still SUSPENDED and nothing re-ran', async () => {
  const w = await sevenSeats(800);
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    assert.equal((await object(w, w.runs.dissents.eid)).status, 201);
    const eid = w.runs.dissents.eid;
    const before = resultFinality(w.holder.round, w.rid, eid).state;
    await wait(1700);                      // two windows
    const after = resultFinality(w.holder.round, w.rid, eid);
    const may = w.holder.preimages.mayRelease(w.rid, eid);
    const results = w.holder.round.results(w.rid, eid).length;
    const facts = { before, after: after.state, shareReleased: may.ok, resultsHeld: results, rerunResults: 0 };
    console.log('  FACTS (7 seats, contradicted result, objection):', JSON.stringify(facts), '|', after.why);
    assert.deepEqual(facts, { before: 'SUSPENDED', after: 'SUSPENDED', shareReleased: false, resultsHeld: 6, rerunResults: 0 });
    assert.equal(typeof w.holder.verifier.rerun, 'undefined', 'a re-run already exists');
  } finally { await w.close(); }
});
