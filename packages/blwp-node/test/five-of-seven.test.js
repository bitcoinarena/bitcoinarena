// TWO FIRST MARKS ON A FIVE-OF-SEVEN COMMITTEE (M3.3-34, ruled 2026-09-13).
//
// The same ruling as 2 of 2: two different first marks signed by the entry's
// session key are §13B's portable proof, and they FORFEIT with no refund - no
// signed result made up, no agreed run that never happened. On a hold the stake
// does not come back to that player (0 msat); on a lock only the player's own
// expiry refund, never a committee refund; and a seat down at the close or past
// the hold's expiry does not hand the stake back.
//
// SEVEN LIVE DAEMONS, each on its own store and port, each able to go down and
// come back. THE ORDER: seats 4-6 down while the on-time first mark (60) reaches
// seat 0, which forwards it to 1-3 (four receipts, one short of five); 4-6 back;
// a DIFFERENT on-time first mark (30) to seat 4, which forwards it to 5 and 6
// (three receipts). Neither mark can reach five, and seats 0-3 hold the pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { lockPort } from './lock-fixture.js';
import { paidPort, contractFor, say, wait, opts, rand, b32, secretScalar, STAKE, seatAndPlay, WINNER, LOSER,
  RANDOMNESS, GENESIS_HASH, wordsAt } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';

const WINDOW = 800;
const NEEDED = 5;
const curve = { ...feldmanGroup, tweakPoint };
const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');

/** Seven live seats on one round: on holds (`hold`) or on stake locks with their own claim key (`lock`). */
async function sevenSeats(custody) {
  const holdPorts = Array.from({ length: 7 }, () => paidPort());
  const locks = custody === 'lock' ? lockPort() : null;
  const dbs = Array.from({ length: 7 }, () => openStore(':memory:'));
  const mk = (i, port = 0) => serve(dbs[i], { port, ...opts, finality: { everyMs: 100 },
    ...(custody === 'hold' ? { lightning: holdPorts[i] } : { stakeLocks: locks, poolCurve: curve }) });
  const seats = [];
  for (let i = 0; i < 7; i++) seats.push(await mk(i));
  const ports = seats.map((d) => d.port);
  const up = new Set([0, 1, 2, 3, 4, 5, 6]);
  const wire = () => {
    for (const i of up) {
      const there = ports.filter((_, j) => j !== i).map((p) => `http://127.0.0.1:${p}`);
      const d = seats[i];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const c = { ...contractFor(seats.map((d) => d.round.pubkey), BigInt(WINDOW), ports.map((p) => `http://127.0.0.1:${p}`)),
    ...(custody === 'lock' ? { federationId: b32(0xfe) } : {}) };
  const rid = roundId(c);
  for (const d of seats) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  if (custody === 'lock') for (let pass = 0; pass < 2; pass++) for (const d of seats) await d.dkg.run(c.nodes);
  return {
    seats, holdPorts, locks, c, rid, up,
    async down(...is) { for (const i of is) { await seats[i].close(); up.delete(i); } },
    async back(...is) { for (const i of is) { seats[i] = await mk(i, ports[i]); up.add(i); } wire(); },
    async close() { for (const i of [...up]) { try { await seats[i].close(); } catch { /* down */ } } },
  };
}

/** The player: dealt 5 of 7, seated at all seven with its stake seen (a hold, or a lock); two different on-time first marks. */
async function seatWithTwoFirstMarks(w, custody) {
  const preimage = secretScalar();
  const e = rand(32);
  const session = ed25519.utils.randomSecretKey();
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: LOSER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: NEEDED, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: LOSER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: LOSER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: custody === 'lock' ? outpoint : { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: custody === 'lock' ? b32(0x9a) : new Uint8Array(32),
  };
  const eid = entryId(entry);
  let fields = null;
  if (custody === 'lock') {
    fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
      claimPk: w.seats[0].dkg.seatFor(w.c.nodes).pool.groupPublicKey, refundPk: refundKeyOf(LOSER.key), expiration: w.locks.height + 200 };
    await w.locks.put(outpoint, fields);
  }
  for (const d of w.seats) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    if (custody === 'hold') {
      assert.equal((await fetch(`${base}/invoice?entry=${toHex(eid)}`)).status, 200);
      const seen = await fetch(`${base}/stake?entry=${toHex(eid)}`);
      assert.equal(seen.status, 200, await seen.text());
    } else {
      const l = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      assert.equal(l.status, 201, await l.text());
    }
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const firstAt = (tick) => {
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    for (let t = 0; t < tick; t++) step(st, ...wordsAt(t));
    const b = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: tick }, (_, t) => wordsAt(t)), liquidations: [] };
    const m = { roundId: w.rid, entryId: eid, tick, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: batchId(b), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
    return [encodeInputBatch(b), sign(m)];
  };
  return { eid, outpoint, paymentHash: toHex(sha256(preimage)), first: firstAt(60), other: firstAt(30) };
}

/** Seats 4-6 down; the first mark to seat 0 (forwarded to 1-3); 4-6 back; a different one to seat 4 (forwarded to 5, 6). */
async function twoFirstMarks(w, run) {
  await w.down(4, 5, 6);
  const said0 = [];
  for (const m of run.first) said0.push(answer(await say(w.seats[0].port, m)));
  await wait(1500);
  await w.back(4, 5, 6);
  const said4 = [];
  for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
  await wait(3000);
  return { said0, said4, proof: w.seats.map((d) => d.round.equivocation(w.rid, run.eid).length),
    holdsFirst: w.seats.map((d) => (d.round.firstMarkHeld(w.rid, run.eid) ? 1 : 0)) };
}

/**
 * THE WINNER, seated at all seven seats first and then played at each - the
 * fixture's seatAndPlay seats and plays one seat at a time, and on seven seats a
 * first mark forwarded by an earlier seat can reach a later one after it is
 * seated: measured, its batch then answered '0' (round.batch: a repeat writes no
 * tick), not the 1320 seatAndPlay requires. Here each seat's batch answer is
 * recorded - 1320 fresh or 0 already held by forward - and every seat must
 * receipt the winner's mark.
 */
async function playWinner(w) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: NEEDED, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: WINNER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  for (const d of w.seats) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    assert.equal((await fetch(`${base}/invoice?entry=${toHex(eid)}`)).status, 200);
    const seen = await fetch(`${base}/stake?entry=${toHex(eid)}`);
    assert.equal(seen.status, 200, await seen.text());
  }
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: WINNER.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < WINNER.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: w.rid, entryId: eid, tick: WINNER.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  const batches = [];
  for (const d of w.seats) {
    const took = await say(d.port, encodeInputBatch(input));
    batches.push(took);
    assert.ok(took === String(WINNER.ticks) || took === '0', `the winner's batch was refused: ${took}`);
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES, 'a seat did not receipt the winner\'s mark');
  }
  return { eid, preimage, batches };
}

const stateAt = (w, run) => w.seats.map((d, i) => {
  if (!w.up.has(i)) return 'down';
  const nq = d.round.noQuorum(run.eid);
  return `${nq ? nq.outcome : 'none'}/${d.round.results(w.rid, run.eid).length}`;
});
const holds = (w, hash) => ({ settled: w.holdPorts.map((p) => p.settled.filter((s) => s.paymentHash === hash).length),
  cancelled: w.holdPorts.map((p) => p.cancelled.filter((s) => s.paymentHash === hash).length) });

test('5 of 7, a hold: two first marks, every seat up at the close - FORFEIT at all seven with no signed result, and the hold SETTLED into the pool, never back to the player', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const before = await twoFirstMarks(w, run);
    const winner = await playWinner(w);
    const winnerHash = toHex(sha256(winner.preimage));
    await Promise.all(w.seats.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const decided = () => w.seats.every((d) => d.round.noQuorum(run.eid))
      && w.seats.filter((d) => resultFinality(d.round, w.rid, winner.eid).state === 'FINAL').length >= NEEDED;
    for (let t = Date.now(); Date.now() - t < 30000 && !decided(); await wait(250));
    for (let t = Date.now(); Date.now() - t < 20000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const m = await w.seats[0].stakes();
    const row = ((m.table && m.table.table) || []).find((r) => toHex(r.pubkey) === toHex(WINNER.key));
    const facts = { before, seats: stateAt(w, run), hold: holds(w, run.paymentHash), winnerHold: holds(w, winnerHash),
      winnerFinal: w.seats.filter((d) => resultFinality(d.round, w.rid, winner.eid).state === 'FINAL').length,
      tableAt0: { pool: m.table ? String(m.table.pool) : null, winnerMsat: row ? String(row.amountMsat) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : (m.ok === false ? String(m.why).slice(0, 80) : null) } };
    console.log('  FACTS (5 of 7, hold, all up):', JSON.stringify(facts));
    assert.deepEqual(facts.seats, Array(7).fill('FORFEIT/0'), 'not FORFEIT with no signed result at every seat');
    assert.deepEqual(facts.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(facts.hold.settled.some((n) => n > 0), 'no seat settled the two-first-marks hold: it expires back to the player');
    assert.ok(facts.winnerHold.cancelled.some((n) => n > 0), 'the winner\'s own hold was not cancelled back to it');
    assert.equal(facts.tableAt0.winnerMsat, String(2n * (STAKE - entryFeeMsat(STAKE))), 'the forfeited stake does not reach the winner in the table');
  } finally { await w.close(); }
});

test('5 of 7, a hold: two first marks, and seats 4-6 down from before the close through the hold\'s expiry - the four seats up still FORFEIT and SETTLE the hold, nothing goes back to the player', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const before = await twoFirstMarks(w, run);
    await playWinner(w);
    await w.down(4, 5, 6);                                                     // three seats: only four shares are up
    await Promise.all([0, 1, 2, 3].map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 20000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const opened = await w.seats[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { before, seats: stateAt(w, run), hold: holds(w, run.paymentHash),
      custodyRows: w.seats.map((d, i) => (w.up.has(i) ? ((d.round.hold(run.eid) || {}).state || null) : 'down')),
      seat0Opens: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 120) };
    console.log('  FACTS (5 of 7, hold, 4-6 down through the expiry):', JSON.stringify(facts));
    assert.deepEqual(facts.seats.slice(0, 4), Array(4).fill('FORFEIT/0'), 'a seat that is up did not FORFEIT with no signed result');
    assert.deepEqual(facts.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(facts.hold.settled.slice(0, 4).some((n) => n > 0), 'no seat that is up settled the hold: it expires back to the player');
  } finally { await w.close(); }
});

test('5 of 7, a stake lock: two first marks - FORFEIT at all seven, no seat signs the refund, no forfeit kept, the lock held (back only by the player\'s own expiry refund)', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const before = await twoFirstMarks(w, run);
    await Promise.all(w.seats.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (let t = Date.now(); Date.now() - t < 30000 && !w.seats.every((d) => d.round.noQuorum(run.eid)); await wait(250));
    await wait(1000);
    const seatsAfter = stateAt(w, run);
    const doors = [];
    for (const d of w.seats) doors.push((await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status);
    const facts = { before, seats: seatsAfter, doors, forfeitKept: w.seats.map((d) => (d.round.forfeit(run.eid) ? 1 : 0)),
      lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (5 of 7, lock):', JSON.stringify(facts));
    assert.deepEqual(facts.seats, Array(7).fill('FORFEIT/0'), 'not FORFEIT with no signed result at every seat');
    assert.deepEqual(facts.doors, Array(7).fill(409), 'a seat signs the refund of the lock to the player');
    assert.deepEqual(facts.forfeitKept, Array(7).fill(0), 'a seat keeps a refund of the lock');
    assert.equal(facts.lockHeld, true);
  } finally { await w.close(); }
});
