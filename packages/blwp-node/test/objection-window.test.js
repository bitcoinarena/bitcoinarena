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
// The window here is the CONTRACT's, and short: 3 s on the two-seat round, so
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
import { HELD, SETTLED, CANCELLED } from '../src/custody.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated, assumeStakeSeen } from './seating.js';
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
  b32, rand, RANDOMNESS, BEACON, STAKE, WINDOW_MS, HTLC_EXPIRY, wait, WINNER, LOSER, paidPort, contractFor, say, seatAndPlay, opts, sevenSeats, object,
} from './window-fixture.js';


test('two seats, a 3 s window: nothing is settled, cancelled or handed out inside it, and the loser settles and the winner cancels after it', async () => {
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA, finality: { everyMs: 100 } });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB, finality: { everyMs: 100 } });
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
    // P2: each seat posts the run's transcript to the other's relay door and its own.
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS),
      [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`]);
    const rid = roundId(c);
    for (const d of [a, b]) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeSeated(d.round, rid, c.nodes);
    }
    const winner = await seatAndPlay([a, b], c, rid, WINNER, 2);
    const loser = await seatAndPlay([a, b], c, rid, LOSER, 2);

    const closedAt = Date.now();
    assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;
    const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;

    // BOTH SEATS AGREE ON BOTH RUNS well inside the window - the quorum is there.
    const agreedOn = async (d) => ((await d.stakes()).agreed || []).length === 2;
    const stop = Date.now() + WINDOW_MS - 1000;
    while (Date.now() < stop && !(await agreedOn(a) && await agreedOn(b))) await wait(50);
    assert.ok(await agreedOn(a) && await agreedOn(b), 'the committee did not agree on both runs early in the window');

    // INSIDE THE WINDOW: every hold HELD, Lightning told nothing, and a seat's
    // share of the lost stake is not handed out.
    await wait(Math.max(0, closedAt + WINDOW_MS - 600 - Date.now()));
    const acts = () => [portA, portB].map((p) => [...p.settled, ...p.cancelled].map((x) => x.at - closedAt));
    console.log(`[window] acts at ms after the close, A and B: ${JSON.stringify(acts())}`);
    for (const [name, d] of [['A', a], ['B', b]]) {
      assert.equal(stateOf(d, loser.eid), HELD, `${name} moved the lost stake inside the window: ${(d.round.hold(loser.eid) || {}).why}`);
      assert.equal(stateOf(d, winner.eid), HELD, `${name} moved the winner's stake inside the window: ${(d.round.hold(winner.eid) || {}).why}`);
    }
    assert.deepEqual([portA.settled, portA.cancelled, portB.settled, portB.cancelled].map((x) => x.length), [0, 0, 0, 0],
      `Lightning was told to act inside the window: ${JSON.stringify([portA, portB].map((p) => [p.settled, p.cancelled]))} (closed at ${closedAt})`);
    // AND THE POOL OWES NOBODY YET: paying the winner is money moving on the
    // same results, so no payout is queued inside the window either.
    for (const [name, d] of [['A', a], ['B', b]])
      assert.equal(d.round.payout(rid), null, `${name} queued a payout inside the window: ${JSON.stringify(d.round.payout(rid))}`);
    const asked = await fetch(`http://127.0.0.1:${b.port}/share?round=${toHex(rid)}&entry=${toHex(loser.eid)}&seat=${toHex(a.round.pubkey)}`);
    const said = await asked.text();
    assert.notEqual(asked.status, 200, 'a share of the lost stake was handed out inside the window');
    assert.match(said, /objection window/, `the share was refused for another reason: ${said}`);

    // AFTER IT: the loser's stake settles with its own preimage and the
    // winner's goes back, on both seats - and not one of those acts before the window.
    const done = Date.now() + WINDOW_MS + 8000;
    const moved = () => [a, b].every((d) => stateOf(d, loser.eid) === SETTLED && stateOf(d, winner.eid) === CANCELLED
      && d.round.payout(rid));
    while (Date.now() < done && !moved()) await wait(100);
    for (const [name, d] of [['A', a], ['B', b]]) {
      assert.equal(stateOf(d, loser.eid), SETTLED, `${name} never settled the lost stake after the window: ${(d.round.hold(loser.eid) || {}).why}`);
      assert.equal(stateOf(d, winner.eid), CANCELLED, `${name} never cancelled the winner's stake after the window`);
      assert.ok(d.round.payout(rid), `${name} queued no payout after the window`);
    }
    for (const p of [portA, portB]) {
      assert.deepEqual(p.settled.map((s) => [s.paymentHash, s.preimage]), [[toHex(loser.entry.stakeCommitment), toHex(loser.preimage)]]);
      assert.deepEqual(p.cancelled.map((s) => s.paymentHash), [toHex(winner.entry.stakeCommitment)]);
      for (const act of [...p.settled, ...p.cancelled])
        assert.ok(act.at >= closedAt + WINDOW_MS, `an act ${act.at - closedAt} ms after the close, inside a ${WINDOW_MS} ms window`);
    }
  } finally { await a.close(); await b.close(); }
});

// THE PLAYER IS TOLD WHAT IS HAPPENING TO THEIR STAKE (MF item 14).
//
// "Waiting for settlement. Held stake, threshold signing, refund on expiry.
// The player is waiting on other people's machines and must be told so, with
// the refund path visible the whole time." Since M3.3-32 that wait is a whole
// objection window. `GET /settlement` answers, for an entry this node seated,
// what its hold is, where the run's result stands (13A), when the window
// closes, and the height at which the hold refunds itself if nobody acts.
test('a player can ask where their stake stands: inside the window HELD, provisionally final, the window\'s end and the refund height; after it SETTLED or CANCELLED and FINAL', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort(), finality: { everyMs: 100 } });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort(), finality: { everyMs: 100 } });
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
    // P2: each seat posts the run's transcript to the other's relay door and its own.
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS),
      [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`]);
    const rid = roundId(c);
    for (const d of [a, b]) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeSeated(d.round, rid, c.nodes);
    }
    const winner = await seatAndPlay([a, b], c, rid, WINNER, 2);
    const loser = await seatAndPlay([a, b], c, rid, LOSER, 2);
    const closedAt = Date.now();
    assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;
    const agreedOn = async (d) => ((await d.stakes()).agreed || []).length === 2;
    const stop = Date.now() + WINDOW_MS - 1000;
    while (Date.now() < stop && !(await agreedOn(a) && await agreedOn(b))) await wait(50);

    const ask = async (d, eid) => {
      const r = await fetch(`http://127.0.0.1:${d.port}/settlement?entry=${toHex(eid)}`);
      const body = await r.text();
      return { status: r.status, body, json: r.status === 200 ? JSON.parse(body) : null };
    };
    const stakeSays = async (d, eid) => (await (await fetch(`http://127.0.0.1:${d.port}/stake?entry=${toHex(eid)}`)).text()).trim();
    // SINCE P2 THE WINDOW OPENS WHEN BOTH SEATS HAVE POSTED THE RUN'S
    // TRANSCRIPT, which can land a tick after they agree: measured under load,
    // B was asked in between and named no window end. Wait until every seat
    // names one for every run - still a second inside the window - then ask.
    const opened = async () => {
      for (const d of [a, b])
        for (const run of [winner, loser]) {
          const s = await ask(d, run.eid);
          if (!s.json || s.json.windowClosesAtMs === null) return false;
        }
      return true;
    };
    while (Date.now() < stop && !(await opened())) await wait(50);

    for (const [name, d] of [['A', a], ['B', b]])
      for (const [who, run] of [['winner', winner], ['loser', loser]]) {
        const s = await ask(d, run.eid);
        console.log(`[settlement] inside the window, ${name} on the ${who}: /settlement ${s.status} ${s.body.trim().slice(0, 160)}; /stake ${await stakeSays(d, run.eid)}`);
        assert.equal(s.status, 200, `${name} would not say where the ${who}'s stake stands: ${s.status} ${s.body}`);
        assert.equal(s.json.hold, HELD);
        assert.equal(s.json.finality, 'PROVISIONALLY_FINAL');
        const closes = Number(s.json.windowClosesAtMs);
        assert.ok(closes >= closedAt + WINDOW_MS && closes <= Date.now() + WINDOW_MS,
          `${name} names a window end ${closes - closedAt} ms after the close, for a ${WINDOW_MS} ms window`);
        assert.equal(s.json.refundHeight, HTLC_EXPIRY, `${name} does not name the height the ${who}'s hold refunds at`);
      }

    const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;
    const done = Date.now() + WINDOW_MS + 8000;
    while (Date.now() < done && ![a, b].every((d) => stateOf(d, loser.eid) === SETTLED && stateOf(d, winner.eid) === CANCELLED)) await wait(100);
    for (const [name, d] of [['A', a], ['B', b]])
      for (const [who, run, want] of [['winner', winner, CANCELLED], ['loser', loser, SETTLED]]) {
        const s = await ask(d, run.eid);
        console.log(`[settlement] after the window, ${name} on the ${who}: /settlement ${s.status} ${s.body.trim().slice(0, 160)}; /stake ${await stakeSays(d, run.eid)}`);
        assert.equal(s.status, 200);
        assert.equal(s.json.hold, want, `${name} says the ${who}'s stake is ${s.json.hold} after the window`);
        assert.equal(s.json.finality, 'FINAL');
      }

    const stranger = await fetch(`http://127.0.0.1:${a.port}/settlement?entry=${'ab'.repeat(32)}`);
    assert.equal(stranger.status, 404, 'a node answered for an entry it never seated');
  } finally { await a.close(); await b.close(); }
});

// A DAEMON RESTARTED INSIDE THE WINDOW STILL ACTS AFTER IT (M3.3-33).
//
// The finality watch lives in memory and is started by a close. With the
// reference window that is ten minutes in which a daemon that restarts - an
// upgrade, a crash, a reboot - comes back with nothing to settle its closed
// round: its holds stay HELD and expire back to the players, the loser's
// included. The store has everything the close logic needs, so a daemon that
// starts picks up every closed round it still holds a HELD stake for.
test('two seats restarted inside a 3 s window: after it the loser settles and the winner cancels on both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-restart-'));
  const portA = paidPort();
  const portB = paidPort();
  const start = (file, port) => serve(openStore(join(dir, file)), { port: 0, ...opts, lightning: port, finality: { everyMs: 100 } });
  const wire = (x, y) => {
    for (const [d, other] of [[x, y], [y, x]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
  };
  let a = await start('a.sqlite', portA);
  let b = await start('b.sqlite', portB);
  try {
    wire(a, b);
    // P2: each seat posts the run's transcript to the other's relay door and its own.
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS),
      [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`]);
    const rid = roundId(c);
    for (const d of [a, b]) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeSeated(d.round, rid, c.nodes);
    }
    const winner = await seatAndPlay([a, b], c, rid, WINNER, 2);
    const loser = await seatAndPlay([a, b], c, rid, LOSER, 2);

    const closedAt = Date.now();
    assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;
    const agreedOn = async (d) => ((await d.stakes()).agreed || []).length === 2;
    const stop = Date.now() + WINDOW_MS - 1000;
    while (Date.now() < stop && !(await agreedOn(a) && await agreedOn(b))) await wait(50);
    assert.ok(await agreedOn(a) && await agreedOn(b), 'the committee did not agree on both runs early in the window');

    // BOTH RESTART, inside the window, on their own stores and the same lnd.
    await a.close();
    await b.close();
    assert.ok(Date.now() < closedAt + WINDOW_MS, 'the restart came after the window, so it tests nothing');
    a = await start('a.sqlite', portA);
    b = await start('b.sqlite', portB);
    wire(a, b);

    const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;
    const done = Date.now() + WINDOW_MS + 10000;
    const moved = () => [a, b].every((d) => stateOf(d, loser.eid) === SETTLED && stateOf(d, winner.eid) === CANCELLED);
    while (Date.now() < done && !moved()) await wait(100);
    for (const [name, d] of [['A', a], ['B', b]]) {
      assert.equal(stateOf(d, loser.eid), SETTLED, `${name}, restarted inside the window, never settled the lost stake: ${(d.round.hold(loser.eid) || {}).why}`);
      assert.equal(stateOf(d, winner.eid), CANCELLED, `${name}, restarted inside the window, never cancelled the winner's stake`);
    }
    for (const p of [portA, portB]) {
      assert.deepEqual(p.settled.map((s) => [s.paymentHash, s.preimage]), [[toHex(loser.entry.stakeCommitment), toHex(loser.preimage)]]);
      for (const act of [...p.settled, ...p.cancelled])
        assert.ok(act.at >= closedAt + WINDOW_MS, `an act ${act.at - closedAt} ms after the close, inside a ${WINDOW_MS} ms window`);
    }
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('seven seats: an objection filed in the window against a run this node replayed differently SUSPENDS it - no share, before or after the window; one against a run it agrees with does not', async () => {
  const w = await sevenSeats(1500);
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

test('seven seats: the window opens when this node held the threshold, not when it held the first result', async () => {
  const w = await sevenSeats(1500);
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

test('seven seats: an objection against a run this node replayed differently, filed after the window closed, reopens nothing', async () => {
  const w = await sevenSeats(1000);
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
