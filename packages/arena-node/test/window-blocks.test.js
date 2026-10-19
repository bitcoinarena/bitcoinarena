// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13C'S EVIDENCE ON THE RE-RUN WINDOW, ON THE WALL CLOCK (§13A, WINDOW-10-SPEC, RULED 2026-10-01).
//
// Until that ruling every §13A window was blocks at both ends (RULED 2026-09-24), and this file locked it: two holders with
// the same blocks named the same outcome, a node without the end block decided nothing, a filing was placed by the block it
// named. The window is now 600 s of wall time from the round's end, the same instant on every node, and the re-run window
// is decided at the round's end + 1205 s on each seat's clock (window-10.test.js measures the windows themselves). What
// stays from the old file is §13C's evidence: a pair of first marks a holder holds when it decides counts; one that reaches
// it after its decision changes nothing - the decision is written once. Two holder daemons (B on a byte copy of A's store)
// must name the same outcome and file the same first-result slash set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { CLOCK } from './block-clock.js';
import { sevenSignerNodes, object, WINDOW_MS, wait, opts, say } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { rerunIsAgreed, decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const at = (d, now) => Object.assign(Object.create(d.round), { now: () => now });
async function until(cond, ms = 8000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(25)) if (cond()) return true;
  return cond();
}

// THE LATE PAIR: the objection, the holder's re-run and three others - short of five, so §13C decides at the round's end +
// 1205 s. After both holders decided, the player's second first mark reaches node A only. Both holders must name the same
// outcome and file the same first-result slash set.
const seven = () => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });
const decidesAt = (w) => Number(windowsOf(w.contract).rerunDeadlineMs);

test('a pair that reaches a holder after it decided the re-run window counts for nothing: the same §13C outcome and the same first-result slash set at both holders', async () => {
  const w = await seven();
  const dir = mkdtempSync(join(tmpdir(), 'evidenceblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    // B REPLAYS UNDER THE ROUND'S OWN BEACON, as A does (§13A,: an objection's bundle is replayed at each door)
    b = await serve(openStore(join(dir, 'b.sqlite')), { plugins: HOSTED, port: 0, ...opts, advertsFor: () => w.adverts,
      randomnessFor: w.holder.verifier.randomnessFor, chainFor: w.holder.verifier.chainFor });
    b.round.chainView = CLOCK.chainView();
    const B = { holder: b, rid: w.rid };
    assert.equal((await object(w, eid)).status, 201);
    assert.equal((await object(B, eid)).status, 201);
    const ownOf = (d) => d.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => ownOf(w.holder)), 'node A never re-ran');
    const holderRerun = ownOf(w.holder);
    b.round.putRerun(w.rid, eid, holderRerun.signerNodePubkey, holderRerun.bytes);
    w.rerunBy('dissents', 3);
    for (const r of w.holder.round.reruns(w.rid, eid)) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    const endTs = decidesAt(w);
    skipTo(endTs + 1000);
    // EACH HOLDER'S RE-RUN WATCH DECIDES ON ITS NEXT TICK, AND WRITES IT.
    assert.ok(await until(() => [w.holder, b].every((d) => d.round.noQuorum(eid)), 20000), 'a holder did not write its §13C decision');
    const pairAfterEnd = testNow() >= endTs;
    const said = await say(w.holder.port, w.runs.dissents.otherFirstMark());          // to A only, after it decided
    await wait(300);
    const read = (d) => resultFinality(d.round, w.rid, eid);
    const states = [w.holder, b].map((d) => { const f = read(d); return { state: f.state, noQuorum: !!f.noQuorum, proof: d.round.provenTwoFirstMarks(w.rid, eid) }; });
    // THE FIRST-RESULT SLASH FOLLOWS THE §13C RECORD: whatever each holder's watch filed, and a filing asked for now.
    for (const d of [w.holder, b]) await d.verifier.fileFirstResultSlashProofs(w.rid, eid);
    const slashes = [w.holder, b].map((d) => d.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey)).sort().join(','));
    console.log('  FACTS (late pair, re-run window):', JSON.stringify({ pairAfterEnd, said: String(said).slice(0, 80), states, slashes: slashes.map((s) => s.split(',').filter(Boolean).length), sameSlash: slashes[0] === slashes[1] }));
    assert.equal(pairAfterEnd, true, 'the second first mark was not sent after the decision: not the case the test names');
    assert.equal(states[0].proof, true, 'A holds no pair: not the case the test names');
    assert.equal(states[1].state, 'VOID', `B: ${JSON.stringify(states[1])}`);
    assert.equal(states[0].state, states[1].state, `the holders split on a pair after the decision: A ${states[0].state}, B ${states[1].state}`);
    assert.equal(slashes[0], slashes[1], 'the holders file different first-result slash sets');
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// AND THE SAME PAIR IN TIME: the player's second first mark reaches both holders before they decide - it counts at both,
// and both name FORFEIT and hold the same first-result slash set.
test('a pair that reaches both holders before they decide the re-run window counts at both: FORFEIT at both, the same first-result slash set', async () => {
  const w = await seven();
  const dir = mkdtempSync(join(tmpdir(), 'evidenceblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    // B REPLAYS UNDER THE ROUND'S OWN BEACON, as A does (§13A,: an objection's bundle is replayed at each door)
    b = await serve(openStore(join(dir, 'b.sqlite')), { plugins: HOSTED, port: 0, ...opts, advertsFor: () => w.adverts,
      randomnessFor: w.holder.verifier.randomnessFor, chainFor: w.holder.verifier.chainFor });
    b.round.chainView = CLOCK.chainView();
    const B = { holder: b, rid: w.rid };
    assert.equal((await object(w, eid)).status, 201);
    assert.equal((await object(B, eid)).status, 201);
    const second = w.runs.dissents.otherFirstMark();
    for (const d of [w.holder, b]) await say(d.port, second);                        // to both, inside the window
    const endTs = decidesAt(w);
    const pairBeforeEnd = testNow() < endTs;
    const ownOf = (d) => d.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => ownOf(w.holder)), 'node A never re-ran');
    const holderRerun = ownOf(w.holder);
    b.round.putRerun(w.rid, eid, holderRerun.signerNodePubkey, holderRerun.bytes);
    w.rerunBy('dissents', 3);
    for (const r of w.holder.round.reruns(w.rid, eid)) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    skipTo(endTs + 1000);
    await until(() => [w.holder, b].every((d) => d.round.noQuorum(eid)), 20000);
    const states = [w.holder, b].map((d) => { const f = resultFinality(d.round, w.rid, eid); return { state: f.state, noQuorum: !!f.noQuorum }; });
    for (const d of [w.holder, b]) await d.verifier.fileFirstResultSlashProofs(w.rid, eid);
    const slashes = [w.holder, b].map((d) => d.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey)).sort().join(','));
    console.log('  FACTS (pair inside, re-run window):', JSON.stringify({ pairBeforeEnd, states, slashes: slashes.map((s) => s.split(',').filter(Boolean).length), sameSlash: slashes[0] === slashes[1] }));
    assert.equal(pairBeforeEnd, true, 'the second first mark was not sent before the decision: not the case the test names');
    assert.deepEqual(states.map((x) => x.state), ['FORFEIT', 'FORFEIT']);
    assert.equal(slashes[0], slashes[1], 'the holders file different first-result slash sets');
    assert.ok(slashes[0].split(',').filter(Boolean).length > 0, 'no first-result signer was slashed');
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
