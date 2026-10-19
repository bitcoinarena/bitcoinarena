// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13C'S EVIDENCE IS TIED TO THE BLOCK IT SITS IN, AND A LATE CLOSER GETS NO FREE STAND (RULED 2026-09-24).
//
// THE RULING:
//   - Every evidence record - a first mark kept as a checkpoint, a pair, an equivocation, a late start, the Void's first
//     mark, a refused first mark, a peer's refusal answer - stores the tip of the node that records it. A pulled record
//     keeps the block the peer named. A holder places a proof at the earliest block among the records it holds.
//   - Evidence counts when its block is strictly before that window's end block (the open is not a floor: play-time
//     evidence counts). A pair counts only if both its marks do. The same on the result window and the re-run window.
//   - No free stand: past the end block an ENTRY_VOID with no counted pair does not end the close; every holder writes
//     the same §13C record - VOID, or FORFEIT on a counted pair - and the first-result slash follows that record.
//
// THE CHAIN is the fixtures' block clock (block-clock.js).
import { testNow, skipTo } from './test-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toHex, say, wait, WINDOW, sevenSignerNodes, joinWithTwoFirstMarks, pathTwoSignerNodeFourDown, refundNow, signerNodeHolds,
} from './five-of-seven-fixture.js';
import { CLOCK } from './block-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';

const endOf = (c, W) => (Number(roundEndMs(c)) + 605000);
async function until(cond, ms = 30000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (await cond()) return true;
  return !!(await cond());
}

// RED 1 - THE LATE CLOSER. Path 2 with signer node 4 down (it holds the pair and stays down): signer nodes 0-3 voided on
// a real outage, 5 and 6 were shown the Void by the forfeit doors. 0-3 close before the result window's end block, 5 and
// 6 after it. Every holder must write the same §13C record and file the same slash set.
test('a late closer holding a peer\'s ENTRY_VOID writes the same §13C VOID and the same slash set as a holder that closed before the end block', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    const doors = await refundNow(w, run);
    const endMs = endOf(w.c, WINDOW);
    const early = [0, 1, 2, 3];
    const late = [5, 6];
    const earlyClosedBeforeEnd = testNow() < endMs;
    await Promise.all(early.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    const beforeEnd = early.map((i) => !!w.signerNodes[i].round.noQuorum(run.eid));
    skipTo(endMs + 2000);
    await until(() => early.every((i) => w.signerNodes[i].round.noQuorum(run.eid)));
    await Promise.all(late.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await until(() => late.every((i) => w.signerNodes[i].round.noQuorum(run.eid)), 15000);
    const rec = (i) => {
      const d = w.signerNodes[i];
      const nq = d.round.noQuorum(run.eid);
      return { i, outcome: nq ? nq.outcome : null, voided: !!d.round.entryVoid(run.eid),
        slashes: d.round.slashProofs(w.rid, run.eid).map((p) => toHex(p.nodePubkey)).sort().join(',') };
    };
    const at = [...early, ...late].map(rec);
    console.log('  FACTS (late closer):', JSON.stringify({ setup: { voidedFirst: setup.voidedFirst, lateAt4: setup.lateAt4 },
      doors: { voids: doors.voids, voidsAfterDoors: doors.voidsAfterDoors, doors: doors.doors }, earlyClosedBeforeEnd, beforeEnd, at,
      holds: late.map((i) => signerNodeHolds(w, run, i)) }));
    assert.equal(earlyClosedBeforeEnd, true, 'the early holders did not close before the end block: not the case the test names');
    assert.deepEqual(beforeEnd, early.map(() => false), 'a holder wrote before the end block');
    assert.ok(late.every((i) => w.signerNodes[i].round.entryVoid(run.eid)), 'a late closer holds no peer ENTRY_VOID: not the case the test names');
    assert.deepEqual(at.map((x) => x.outcome), at.map(() => 'VOID'), 'the holders do not write the same §13C record');
    assert.equal(new Set(at.map((x) => x.slashes)).size, 1, 'the holders do not hold the same slash set');
  } finally { await w.close(); }
});
