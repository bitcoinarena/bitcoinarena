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

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const STAKE = 100000n;
const WINDOW_MS = 3000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// second-closer's two players: the winner DELIVERS by tick 1320, the loser
// wrecks at tick 547.
const WINNER = { name: 'winner', key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}d1`), ticks: 1320 };
const LOSER = { name: 'loser', key: b32(5), worldSecret: b32(0x16), ticks: 1000 };

/** A Lightning node whose players have paid, and which writes down WHEN it was told to act. */
function paidPort() {
  const amounts = new Map();
  const settled = [];
  const cancelled = [];
  return {
    settled, cancelled,
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a }; },
    async settle({ paymentHash, preimage }) { settled.push({ paymentHash: toHex(paymentHash), preimage: toHex(preimage), at: Date.now() }); },
    async cancel({ paymentHash }) { cancelled.push({ paymentHash: toHex(paymentHash), at: Date.now() }); },
  };
}

const contractFor = (nodes, objectionWindowMs) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/** One player's stake dealt at `needed` to every seat, seated, paid and played on `daemons`. */
async function seatAndPlay(daemons, c, rid, who, needed) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, seats: c.nodes, roundId: rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout),
  };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of daemons) {
    const took = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    assert.equal(took.status, 201, `${who.name}'s handout: ${await took.text()}`);
    const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, `${who.name}'s entry: ${await seated.text()}`);
    const quote = await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`);
    assert.equal(quote.status, 200, `${who.name}'s invoice: ${await quote.text()}`);
    assumeStakeSeen(d.round, entry);
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, preimage, mid: checkpointId(mark) };
}

const opts = { funded: () => true, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: 'test port' }) };

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
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS));
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
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS));
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

/**
 * ONE DAEMON ON A SEVEN-SEAT ROUND, the other six seats' keys this test holds.
 * Two losers play on it and it signs its own result for each; then `sign` has
 * five of the other seats sign - the same run it did, or a rewritten one - and
 * the run is PROVISIONALLY_FINAL on it.
 */
async function sevenSeats(windowMs) {
  const holder = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort() });
  try {
    const others = Array.from({ length: 6 }, () => rand(32));
    const c = contractFor([holder.round.pubkey, ...others.map((s) => schnorr.getPublicKey(s))], BigInt(windowMs));
    const rid = roundId(c);
    await fetch(`http://127.0.0.1:${holder.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(holder.round, rid, c.nodes);
    const runs = {};
    for (const [name, key] of [['agrees', 5], ['dissents', 6]]) {
      runs[name] = await seatAndPlay([holder], c, rid, { ...LOSER, name, key: b32(key) }, 5);
      // FIVE OF SEVEN RECEIPTS MAKE THE TRANSCRIPT CANONICAL: its own and four seats'.
      for (const secret of others.slice(0, 4)) {
        const receipt = { checkpointId: runs[name].mid, receivedAtMs: 1234n, nodePubkey: schnorr.getPublicKey(secret) };
        assert.equal(await say(holder.port, joinSignedReceipt(encodeCheckpointReceipt(receipt),
          schnorr.sign(receiptId(receipt), secret))), 'held');
      }
    }
    assert.equal(await say(holder.port, `close ${toHex(rid)}`), 'closed');
    for (const p of holder.verifier.done) await p;
    await holder.verifier.settling;

    const sign = (name, rewrite) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      assert.ok(mine, `the holder signed no result for ${name}`);
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      assert.equal(shape.outcome, 'FAILED', `${name} did not lose`);
      for (const secret of others.slice(0, 5)) {
        const r = { ...shape, ...rewrite(shape), nodePubkey: schnorr.getPublicKey(secret) };
        const id = resultId(r);
        holder.round.putResult(rid, eid, r.nodePubkey, id, joinSignedResult(encodePlayerResult(r), schnorr.sign(id, secret)));
      }
    };
    return { holder, rid, runs, sign, close: () => holder.close() };
  } catch (err) { await holder.close(); throw err; }
}

const object = (w, eid) => fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST' });

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
