// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO STAKE MOVES AND NO SHARE LEAVES UNTIL THE OBJECTION WINDOW HAS CLOSED (M3.3-32).
//
// Section 13A: a result five of seven (here two of two) signed is
// PROVISIONALLY_FINAL; "it becomes FINAL when the window closes without a
// valid objection", and "taking a player's stake requires a final result, an
// elapsed objection window, and a threshold quorum". Measured before: the
// daemon took the quorum as final and settled the loser, cancelled the winner
// and handed out shares within about a second of the close, whatever window
// the round's contract named. `arena-protocol/src/objection.js` had the rule and no
// file in the daemon called it.
//
// The window here is the CONTRACT's, and short: 3 s on the two-signer node round, so
// the test can watch both sides of it on the daemons' own clocks.
//
// A VALID OBJECTION SUSPENDS. What makes one valid is `objectionHolds`: the
// committee's receipts, and a replay that contradicts the signed result. The
// replay a daemon has is its own, so an objection filed against a run holds on
// a node whose own result is not the one the quorum signed - and on a node
// that agrees with the quorum it is a claim, which the window exists to outlast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned, assumeStakeSeen } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import {
  SIGNED_RECEIPT_BYTES, encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../arena-protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { resultFinality } from '../src/finality.js';
import { testNow } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import {
  b32, rand, RANDOMNESS, BEACON, STAKE, WINDOW_MS, wait, WINNER, LOSER, contractFor, say, joinAndPlay, opts, sevenSignerNodes, object,
} from './window-fixture.js';

// ON THE WALL CLOCK FROM THE ROUND'S END (§13A, WINDOW-10-SPEC, RULED 2026-10-01): each round here ends a few
// seconds ahead, its objection window is [end, end + 600 s), a seat signs FINAL from end + 605 s, and five signatures make
// it FINAL. Reads at named instants are the holder's store at a stubbed clock; FINAL is the holder's own signature and four
// others', the fixtures' clock skipped past final_after.
const seven = () => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });
const winOf = (w) => Object.fromEntries(Object.entries(windowsOf(w.contract)).map(([k, v]) => [k, Number(v)]));

test('seven signer nodes: an objection filed in the window against a run this node replayed differently SUSPENDS it - no share, before or after the window; one against a run it agrees with does not', async () => {
  const w = await seven();
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eidOf = (name) => w.runs[name].eid;
    const clockAt = (now) => Object.assign(Object.create(w.holder.round), { now: () => now });
    const mayAt = (now, name) => new (w.holder.stakeSecrets.constructor)(clockAt(now), {}).mayRelease(w.rid, eidOf(name));
    const win = winOf(w);
    // BOTH WINDOWS OPEN AT THE ROUND'S END, the same instant: no posting, block or signature moves them.
    const opens = ['agrees', 'dissents'].map((n) => resultFinality(w.holder.round, w.rid, eidOf(n)).provisionalAtMs);
    assert.deepEqual(opens, [win.openMs, win.openMs]);
    const mid = testNow();
    for (const name of ['agrees', 'dissents']) {
      const before = mayAt(mid, name);
      assert.equal(before.ok, false, `${name}: a share was released inside the window`);
      assert.match(before.why, /objection window/, `${name}: refused for another reason: ${before.why}`);
      // AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13A): against the run the committee signed as the
      // holder replayed it, the bundle is refused at the door (422) and nothing is stored; against the forged one, taken.
      const r = await object(w, eidOf(name));
      assert.equal(r.status, name === 'agrees' ? 422 : 201, `${name}: ${await r.text()}`);
    }
    assert.equal(w.holder.round.objected(w.rid, eidOf('agrees')), false, 'a refused objection was stored');
    const dissent = mayAt(testNow(), 'dissents');
    assert.equal(dissent.ok, false);
    assert.match(dissent.why, /suspend/i, `a valid objection did not suspend the run: ${dissent.why}`);
    // PAST end + 605 s: the run whose objection does not hold here is signed FINAL and released; the other stays suspended.
    const agreesFinal = await w.finalNow('agrees');
    assert.equal(agreesFinal.state, 'FINAL', agreesFinal.why);
    const agreed = mayAt(win.finalAfterMs + 100, 'agrees');
    assert.equal(agreed.ok, true, `an objection this node's own replay does not back held the run past the window: ${agreed.why}`);
    const still = mayAt(win.finalAfterMs + 100, 'dissents');
    assert.equal(still.ok, false, 'a suspended run was released once the window closed');
    assert.match(still.why, /suspend/i, still.why);
    // AND AT THE RE-RUN WINDOW'S END (end + 1205 s): still no share, and the run is VOID.
    const ended = mayAt(win.rerunDeadlineMs, 'dissents');
    assert.equal(ended.ok, false, 'a share left the dissent at its re-run window\'s end');
    assert.equal(resultFinality(clockAt(win.rerunDeadlineMs), w.rid, eidOf('dissents')).state, 'VOID');
  } finally { await w.close(); }
});

test('seven signer nodes: the window opens at the round\'s end - not when this node held its own result, nor when it held the threshold', async () => {
  const w = await seven();
  try {
    const ownAt = testNow();
    await wait(1000);
    w.sign('agrees', () => ({}));
    const eid = w.runs.agrees.eid;
    const at = (now) => new (w.holder.stakeSecrets.constructor)(Object.assign(Object.create(w.holder.round), { now: () => now }), {});
    const win = winOf(w);
    const f = resultFinality(w.holder.round, w.rid, eid);
    console.log('  FACTS (window anchor):', JSON.stringify({ ownResultAfterEnd: ownAt - win.openMs, thresholdAfterEnd: testNow() - win.openMs, opensAt: f.provisionalAtMs - win.openMs, length: Number(f.windowCloseMs - f.windowOpenMs) }));
    assert.equal(f.provisionalAtMs, win.openMs, 'the window did not open at the round\'s end');
    assert.equal(Number(f.windowCloseMs - f.windowOpenMs), 600000);
    const inside = at(win.finalAfterMs - 1).mayRelease(w.rid, eid);
    assert.equal(inside.ok, false, 'a share left before end + 605 s');
    assert.match(inside.why, /objection window/, inside.why);
    const signed = await w.finalNow('agrees');
    assert.equal(signed.state, 'FINAL', signed.why);
    const after = at(win.finalAfterMs).mayRelease(w.rid, eid);
    assert.equal(after.ok, true, `the run was not FINAL once five seats signed after end + 605 s: ${after.why}`);
  } finally { await w.close(); }
});

test('seven signer nodes: an objection against a run this node replayed differently, filed after the run is FINAL, reopens nothing', async () => {
  const w = await seven();
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const may = () => w.holder.stakeSecrets.mayRelease(w.rid, w.runs.dissents.eid);
    const signed = await w.finalNow('dissents');
    assert.equal(signed.state, 'FINAL', signed.why);
    const final = may();
    assert.equal(final.ok, true, `the run was not FINAL after its window: ${final.why}`);
    assert.equal((await object(w, w.runs.dissents.eid)).status, 201);
    const after = may();
    assert.equal(after.ok, true, `an objection received after the window un-finalised a FINAL run: ${after.why}`);
    assert.equal(resultFinality(w.holder.round, w.rid, w.runs.dissents.eid).lateObjection, true, 'the late objection was not kept as evidence');
  } finally { await w.close(); }
});
