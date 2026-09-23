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

    await wait(1700);   // the window has closed
    const agreed = may('agrees');
    assert.equal(agreed.ok, true, `an objection this node's own replay does not back held the run past the window: ${agreed.why}`);
    const still = may('dissents');
    assert.equal(still.ok, false, 'a suspended run was released once the window closed');
    assert.match(still.why, /suspend/i, still.why);
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
