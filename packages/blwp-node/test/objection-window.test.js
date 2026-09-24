// NO STAKE MOVES AND NO SHARE LEAVES UNTIL THE OBJECTION WINDOW HAS CLOSED (M3.3-32).
//
// Section 13A: a result five of seven (here two of two) signed is
// PROVISIONALLY_FINAL; "it becomes FINAL when the window closes without a
// valid objection", and "taking a player's stake requires a final result, an
// elapsed objection window, and a threshold quorum". Measured before: the
// daemon took the quorum as final and settled the loser, cancelled the winner
// and handed out shares within about a second of the close, whatever window
// the round's contract named. `protocol/src/objection.js` had the rule and no
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
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import {
  SIGNED_RECEIPT_BYTES, encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { resultFinality } from '../src/finality.js';
import {
  b32, rand, RANDOMNESS, BEACON, STAKE, WINDOW_MS, wait, WINNER, LOSER, contractFor, say, joinAndPlay, opts, sevenSignerNodes, object,
} from './window-fixture.js';

test('seven signer nodes: an objection filed in the window against a run this node replayed differently SUSPENDS it - no share, before or after the window; one against a run it agrees with does not', async () => {
  const w = await sevenSignerNodes(1500);
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const may = (name) => w.holder.preimages.mayRelease(w.rid, w.runs[name].eid);

    for (const name of ['agrees', 'dissents']) {
      const before = may(name);
      assert.equal(before.ok, false, `${name}: a share was released inside the window`);
      assert.match(before.why, /objection window/, `${name}: refused for another reason: ${before.why}`);
      assert.equal((await object(w, w.runs[name].eid)).status, 201);
    }
    const dissent = may('dissents');
    assert.equal(dissent.ok, false);
    assert.match(dissent.why, /suspend/i, `a valid objection did not suspend the run: ${dissent.why}`);

    // THE WINDOW HAS CLOSED - read on the node's own clock, stubbed, at the objection windows' close (RULED 2026-09-24,
    // slice C1): that instant is inside the dissent's re-run window, the only span where SUSPENDED is still legal. A
    // real-clock wait of 1700 ms overshot it, and past it the dissent is §13C's VOID.
    const eidOf = (name) => w.runs[name].eid;
    const clockAt = (now) => Object.assign(Object.create(w.holder.round), { now: () => now });
    const mayAt = (now, name) => new (w.holder.preimages.constructor)(clockAt(now), {}).mayRelease(w.rid, eidOf(name));
    const closes = ['agrees', 'dissents'].map((n) => Number(resultFinality(w.holder.round, w.rid, eidOf(n)).closesAtMs));
    const closed = Math.max(...closes);
    const rerunEnds = w.holder.round.objectedAt(w.rid, eidOf('dissents')) + 1500;
    assert.ok(closed < rerunEnds, `the objection windows close at ${closed}, not inside the re-run window ending at ${rerunEnds}`);
    const agreed = mayAt(closed, 'agrees');
    assert.equal(agreed.ok, true, `an objection this node's own replay does not back held the run past the window: ${agreed.why}`);
    const still = mayAt(closed, 'dissents');
    assert.equal(still.ok, false, 'a suspended run was released once the window closed');
    assert.match(still.why, /suspend/i, still.why);
    // AND AT THE RE-RUN WINDOW'S END: still no share, and the run is VOID - SUSPENDED is legal only until filed + W.
    const ended = mayAt(rerunEnds, 'dissents');
    assert.equal(ended.ok, false, 'a share left the dissent at its re-run window\'s end');
    assert.equal(resultFinality(clockAt(rerunEnds), w.rid, eidOf('dissents')).state, 'VOID');
  } finally { await w.close(); }
});

test('seven signer nodes: the window opens when this node held the threshold, not when it held the first result', async () => {
  const w = await sevenSignerNodes(1500);
  try {
    // Its own result is stored at its replay; the other five arrive a second
    // later, and that is when five agree.
    await wait(1000);
    w.sign('agrees', () => ({}));
    const may = () => w.holder.preimages.mayRelease(w.rid, w.runs.agrees.eid);
    await wait(900);   // past 1500 ms after its own result, inside 1500 ms after the threshold
    const inside = may();
    assert.equal(inside.ok, false, 'the window was counted from this node\'s own result, before five agreed');
    assert.match(inside.why, /objection window/, inside.why);
    await wait(800);
    const after = may();
    assert.equal(after.ok, true, `the run was not FINAL a whole window after the threshold: ${after.why}`);
  } finally { await w.close(); }
});

test('seven signer nodes: an objection against a run this node replayed differently, filed after the window closed, reopens nothing', async () => {
  const w = await sevenSignerNodes(1000);
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const may = () => w.holder.preimages.mayRelease(w.rid, w.runs.dissents.eid);
    await wait(1200);
    const final = may();
    assert.equal(final.ok, true, `the run was not FINAL after its window: ${final.why}`);
    assert.equal((await object(w, w.runs.dissents.eid)).status, 201);
    const after = may();
    assert.equal(after.ok, true, `an objection dated after the window un-finalised a FINAL run: ${after.why}`);
  } finally { await w.close(); }
});
