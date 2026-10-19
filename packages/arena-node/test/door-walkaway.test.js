// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §15 AT THE DOOR (ALL-BUT-MIN-1727, 2026-09-29 17:27): "A seated player whose stake was committed and who sent
// no first mark is FORFEIT, score 0, at the door, not left undecided until the close. Never ENTRY_VOID. Never a refund.
// A first mark after the start deadline is the same FORFEIT."
//
// Two in-process signer nodes of a lock round (first-mark-fixture), the door swept every 250 ms. The player joins and
// locks at both - the stake seen - and sends nothing. With no close sent, once the start window has passed (the stake
// seen + the 900-tick deadline + the 5 s grace), both signer nodes sign FORFEIT 0 over the empty transcript. The
// player's own first mark sent after that is refused FORFEIT at the door, kept as the evidence; nothing changes.
// MEASURED BEFORE (the same test, without the door sweep): both signer nodes still held no result 30 s after the stake.
import { test } from 'node:test';
import { assert, signerNodes, joinAndBuild, outcomeAt, answer } from './first-mark-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';

import { say, wait } from './window-fixture.js';

test('no first mark past the start deadline is FORFEIT 0 at both signer nodes at the door, before any close; a first mark after it is the same FORFEIT', async () => {
  const w = await signerNodes({ serveOpts: { doorSweepMs: 250 } });
  try {
    const run = await joinAndBuild(w);
    const seen = w.a.round.stakeSeen(run.eid);
    assert.ok(seen && w.b.round.stakeSeen(run.eid), 'the stake is committed at both signer nodes');
    const results = (d) => d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
    let at = null;
    for (const stop = Date.now() + 45000; Date.now() < stop; await wait(250)) {
      if (results(w.a).length && results(w.b).length) { at = Date.now(); break; }
    }
    assert.ok(at, 'both signer nodes signed within 45 s of the stake, with no close sent');
    const afterStakeS = (at - seen.seenMs) / 1000;
    const a = results(w.a)[0]; const b = results(w.b)[0];
    assert.deepEqual([a.outcome, a.score, b.outcome, b.score], ['FORFEIT', 0, 'FORFEIT', 0]);
    assert.ok(afterStakeS >= 20, `decided at the door, not before the start window passed: ${afterStakeS} s`);
    assert.equal(w.a.round.entryVoid(run.eid), null, 'never ENTRY_VOID');
    // THE PLAYER'S OWN FIRST MARK, SENT NOW: the same late start
    const said = [];
    for (const m of run.messages.slice(0, 2)) said.push(answer(await say(w.a.port, m)));
    const kept = w.a.round.startForfeit(run.eid);
    const facts = { afterStakeS: Math.round(afterStakeS), a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run), said,
      keptAsEvidence: !!kept, why: kept && kept.why };
    console.log('  FACTS (door):', JSON.stringify(facts));
    assert.match(said.join(' | '), /FORFEIT: this signer node signed the entry FORFEIT at the door/);
    assert.equal(facts.keptAsEvidence, true);
    assert.deepEqual(facts.a.results, ['FORFEIT']);
    assert.deepEqual(facts.b.results, ['FORFEIT']);
    assert.equal(facts.a.forfeit, 409, 'the lock is not handed back');
    assert.equal(w.b.round.entryVoid(run.eid), null, 'never ENTRY_VOID, at either signer node');
    console.log(`  FACTS (door): lock round ${toHex(w.rid).slice(0, 16)}, entry ${toHex(run.eid).slice(0, 16)}`);
  } finally { await w.close(); }
});
