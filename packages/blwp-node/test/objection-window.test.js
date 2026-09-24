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
import { CLOCK } from './block-clock.js';
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
    // BOTH RUNS POSTED IN ONE BLOCK: signed just after a second turns on the fixtures' one-second block clock.
    while (Date.now() % 1000 > 300) await wait(20);
    w.sign('agrees', () => ({}));
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    // ALL ON BLOCKS (RULED 2026-09-24): the first window is [the posting's block, the first block at or after it + W). Every
    // read below is at a stubbed moment of the node's clock - the chain as of then - and each objection names the block
    // one after the open: inside the window, and later than the block it opened at, whatever the machine's speed.
    const eidOf = (name) => w.runs[name].eid;
    const clockAt = (now) => Object.assign(Object.create(w.holder.round), { now: () => now });
    const mayAt = (now, name) => new (w.holder.preimages.constructor)(clockAt(now), {}).mayRelease(w.rid, eidOf(name));
    const opens = ['agrees', 'dissents'].map((n) => resultFinality(w.holder.round, w.rid, eidOf(n)).provisionalAtMs);
    assert.equal(opens[0], opens[1], 'the two runs\' windows did not open at one block');
    const open = opens[0];
    const mid = open + 1000;
    for (const name of ['agrees', 'dissents']) {
      const before = mayAt(mid, name);
      assert.equal(before.ok, false, `${name}: a share was released inside the window`);
      assert.match(before.why, /objection window/, `${name}: refused for another reason: ${before.why}`);
      assert.equal((await object(w, eidOf(name), CLOCK.tipAt(mid))).status, 201);
    }
    const dissent = mayAt(mid, 'dissents');
    assert.equal(dissent.ok, false);
    assert.match(dissent.why, /suspend/i, `a valid objection did not suspend the run: ${dissent.why}`);

    // EACH WINDOW ENDS AT ITS END BLOCK: the first block at or after its open block's time plus W (RULED 2026-09-24).
    const closes = ['agrees', 'dissents'].map((n) => CLOCK.endAt(resultFinality(clockAt(mid), w.rid, eidOf(n)).provisionalAtMs, 1500));
    const closed = Math.max(...closes);
    const rerunEnds = CLOCK.endAt(resultFinality(clockAt(mid), w.rid, eidOf('dissents')).filedAtMs, 1500);
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
    const ownAt = Date.now();
    await wait(1000);
    w.sign('agrees', () => ({}));
    // ON BLOCKS (RULED 2026-09-24): the window is [the threshold's posting block, the first block at or after it + W), read
    // at its end block on the node's own clock stubbed - not by waiting on the wall, which a one-second block makes a race.
    const eid = w.runs.agrees.eid;
    const at = (now) => new (w.holder.preimages.constructor)(Object.assign(Object.create(w.holder.round), { now: () => now }), {});
    const open = resultFinality(w.holder.round, w.rid, eid).provisionalAtMs;
    assert.ok(open > CLOCK.mtpOf(CLOCK.tipAt(ownAt)), 'the window opened at this node\'s own result\'s block, before five agreed');
    const end = CLOCK.endAt(open, 1500);
    const inside = at(end - 1).mayRelease(w.rid, eid);
    assert.equal(inside.ok, false, 'the window was counted from this node\'s own result, before five agreed');
    assert.match(inside.why, /objection window/, inside.why);
    const after = at(end).mayRelease(w.rid, eid);
    assert.equal(after.ok, true, `the run was not FINAL at its window's end block after the threshold: ${after.why}`);
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
