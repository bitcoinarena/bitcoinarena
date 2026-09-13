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
  RANDOMNESS, GENESIS_HASH, wordsAt, PLANTED_FIRST_MARK_DEADLINE } from './window-fixture.js';
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
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';

const WINDOW = 800;
const NEEDED = 5;
const PAST = PLANTED_FIRST_MARK_DEADLINE + 100;          // past the round's start line
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
  // THE CHAIN PAST THE START LINE (the outage-VOID orders): the first mark at 60,
  // then a mark at PAST chaining to it - a seat holding that first mark short of
  // its receipts, the seats it was offered to down, records ENTRY_VOID. And a LATE
  // first mark at PAST, from nothing.
  const hashAt = (tick) => {
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    for (let t = 0; t < tick; t++) step(st, ...wordsAt(t));
    return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  };
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashAt(60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: PAST - 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: PAST, stateHash: hashAt(PAST), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  return { eid, outpoint, paymentHash: toHex(sha256(preimage)), first: firstAt(60), other: firstAt(30),
    past: [encodeInputBatch(b2), sign(m2)], late: firstAt(PAST) };
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
async function playWinner(w, seatsUp = null) {
  const ds = seatsUp ? seatsUp.map((i) => w.seats[i]) : w.seats;      // the seats that are up
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
  for (const d of ds) {
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
  for (const d of ds) {
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

// ---- THE OUTAGE-VOID ORDERS ON 5 OF 7 (ruled: two first marks is FORFEIT even
// after a real outage made seats record ENTRY_VOID; on 5 of 7 one refusing seat
// does not block a refund - five signatures form it). Measured, not read off 2 of 2.

/** Seats 4-6 down; the first mark (60) and a mark past the start line to each of seats 0-3: a real outage, they record ENTRY_VOID. */
async function voidAtZeroToThree(w, run) {
  await w.down(4, 5, 6);
  for (const i of [0, 1, 2, 3]) for (const m of [...run.first, ...run.past]) await say(w.seats[i].port, m);
  for (let t = Date.now(); Date.now() - t < 10000 && [0, 1, 2, 3].some((i) => !w.seats[i].round.entryVoid(run.eid)); await wait(200));
  return [0, 1, 2, 3].filter((i) => w.seats[i].round.entryVoid(run.eid)).length;
}

/**
 * WHAT THE COMMITTEE WOULD DO WITH THE STAKE LOCK NOW, over the seats that are
 * up: how many recorded the Void, how many hold both marks, how many would
 * commit to the refund (POST /forfeit-commit, 200 = would sign), and every
 * refund door (GET /forfeit, 200 = five signatures formed, a refund).
 */
async function refundNow(w, run) {
  const q = `round=${toHex(w.rid)}&entry=${toHex(run.eid)}`;
  const up = [...w.up].sort((a, b) => a - b);
  const count = (f) => up.filter((i) => f(w.seats[i])).length;
  const voids = count((d) => !!d.round.entryVoid(run.eid));
  const both = count((d) => d.round.provenTwoFirstMarks(w.rid, run.eid));
  const commits = [];
  for (const i of up) commits.push((await fetch(`http://127.0.0.1:${w.seats[i].port}/forfeit-commit?${q}`, { method: 'POST' })).status);
  const doors = [];
  for (const i of up) doors.push((await fetch(`http://127.0.0.1:${w.seats[i].port}/forfeit?${q}`)).status);
  return { up: up.length, voids, both, wouldSign: commits.filter((s) => s === 200).length, commits, doors,
    voidsAfterDoors: count((d) => !!d.round.entryVoid(run.eid)), kept: count((d) => !!d.round.forfeit(run.eid)),
    lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}
const NET = STAKE - entryFeeMsat(STAKE);

/** Each seat's own record of the run: the result it signed (outcome/score), its finality, its no-quorum reason. */
const recordsOf = (w, run) => ({
  signed: w.seats.map((d, i) => {
    if (!w.up.has(i)) return 'down';
    const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
    if (!mine) return null;
    const p = decodePlayerResult(splitSignedResult(mine.bytes).body);
    return `${p.outcome}/${p.score}`;
  }),
  finality: w.seats.map((d, i) => (w.up.has(i) ? resultFinality(d.round, w.rid, run.eid).state : 'down')),
  noQuorumWhy: w.seats.map((d, i) => { const nq = w.up.has(i) ? d.round.noQuorum(run.eid) : null; return nq ? String(nq.why).slice(0, 90) : null; }),
});

/** A lock round after every seat that is up closes and the window passes: each seat's record, and every refund door again. */
async function lockAfterClose(w, run) {
  const up = [...w.up].sort((a, b) => a - b);
  await Promise.all(up.map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
  for (let t = Date.now(); Date.now() - t < 20000
    && !up.every((i) => w.seats[i].round.noQuorum(run.eid) || w.seats[i].round.results(w.rid, run.eid).length); await wait(250));
  await wait(WINDOW + 1500);
  const q = `round=${toHex(w.rid)}&entry=${toHex(run.eid)}`;
  const doors = [];
  for (const i of up) doors.push((await fetch(`http://127.0.0.1:${w.seats[i].port}/forfeit?${q}`)).status);
  return { seats: stateAt(w, run), ...recordsOf(w, run), doors, kept: up.filter((i) => !!w.seats[i].round.forfeit(run.eid)).length,
    lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}

/** On a hold: every seat closes, then what each decided, how many hold both marks, and where the hold went. */
async function holdAfterClose(w, run, winner) {
  await Promise.all(w.seats.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
  for (let t = Date.now(); Date.now() - t < 30000 && !w.seats.every((d) => d.round.noQuorum(run.eid)); await wait(250));
  for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
  await wait(1500);
  const h = holds(w, run.paymentHash);
  return { seats: stateAt(w, run), ...recordsOf(w, run), voids: w.seats.filter((d) => d.round.entryVoid(run.eid)).length,
    both: w.seats.filter((d) => d.round.provenTwoFirstMarks(w.rid, run.eid)).length, hold: h,
    winnerHold: holds(w, toHex(sha256(winner.preimage))),
    msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry` };
}

test('5 of 7, a stake lock, path 1: seats 0-3 record ENTRY_VOID on a real outage, then a different on-time first mark reaches seat 4 - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a seat keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} seats would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a seat keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 2: seats 0-3 record ENTRY_VOID, then a late first mark reaches seat 4 alone and its forward is lost - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4);
    await w.down(0, 1, 2, 3);                                                   // seat 4 alone: its forward goes nowhere
    const said4 = [];
    for (const m of run.late) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(1000);
    await w.back(0, 1, 2, 3, 5, 6);
    await wait(1000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, lateAt4: !!w.seats[4].round.startForfeit(run.eid), now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(facts.lateAt4, true, 'seat 4 kept no late first mark: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a seat keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} seats would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a seat keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a hold, path 1: seats 0-3 record ENTRY_VOID, then a different on-time first mark reaches seat 4 - FORFEIT, the hold SETTLED into the pool, 0 msat back', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    console.log('  FACTS (5 of 7, hold, path 1):', JSON.stringify({ voidedFirst, said4, after }));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no seat settled the hold: it expires back to the player - ${JSON.stringify(after.seats)}`);
  } finally { await w.close(); }
});

test('5 of 7, a hold, path 2: seats 0-3 record ENTRY_VOID, then a late first mark reaches seat 4 alone and its forward is lost - FORFEIT, the hold SETTLED into the pool, 0 msat back', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4);
    await w.down(0, 1, 2, 3);
    const said4 = [];
    for (const m of run.late) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(1000);
    await w.back(0, 1, 2, 3, 5, 6);
    await wait(1000);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    console.log('  FACTS (5 of 7, hold, path 2):', JSON.stringify({ voidedFirst, said4, lateAt4: !!w.seats[4].round.startForfeit(run.eid), after }));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no seat settled the hold: it expires back to the player - ${JSON.stringify(after.seats)}`);
  } finally { await w.close(); }
});

// PATH 1 ON A HOLD, AND THE ONE SEAT THAT DECIDED FORFEIT GOES DOWN. Measured
// before this test: in path 1 six seats sign a FAILED result (they took the first
// mark late and carry a transcript) that never agrees 5 of 7, and only seat 4 -
// which refused the second mark - decides FORFEIT and settles. Here seat 4 is
// down from before the close through the hold's expiry: does any seat still keep
// the stake from going back to the player?
test('5 of 7, a hold, path 1, and seat 4 down from before the close through the hold\'s expiry - the hold still SETTLED into the pool, 0 msat back', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    await w.down(4);                                                           // the seat that refused the second mark
    const up = [...w.up];
    await Promise.all(up.map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const h = holds(w, run.paymentHash);
    const facts = { voidedFirst, said4, seats: stateAt(w, run), ...recordsOf(w, run),
      both: up.filter((i) => w.seats[i].round.provenTwoFirstMarks(w.rid, run.eid)).length, hold: h,
      winnerHold: holds(w, toHex(sha256(winner.preimage))),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry` };
    console.log('  FACTS (5 of 7, hold, path 1, seat 4 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no seat settled the hold: ${facts.msatBack} back to the player - ${JSON.stringify(facts.signed)}`);
  } finally { await w.close(); }
});

// PATH 1 WITH SEATS 4-6 DOWN FROM BEFORE THE CLOSE THROUGH THE HOLD'S EXPIRY
// (M3.3-34, measured before any change). The reading to test: the proof formed at
// seat 4; seats 0-3 learned it by pulling and never gathered shares, so with 4-6
// down they hold 4 of the 5 shares a settle needs and the hold expires back.

/** What seat `i` actually holds for the entry: shares it can open (its own + kept envelopes), the proof, its decision, its custody row. */
const seatHolds = (w, run, i) => {
  const d = w.seats[i];
  const nq = d.round.noQuorum(run.eid);
  const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
  return { seat: i, shares: 1 + d.round.heldShares(run.eid).length, proof: d.round.provenTwoFirstMarks(w.rid, run.eid),
    decided: nq ? nq.outcome : null, signed: mine ? (() => { const p = decodePlayerResult(splitSignedResult(mine.bytes).body); return `${p.outcome}/${p.score}`; })() : null,
    voided: !!d.round.entryVoid(run.eid), custody: (d.round.hold(run.eid) || {}).state || null };
};

test('5 of 7, a hold, path 1, seats 4-6 down from before the close through the hold\'s expiry - measured: where the stake goes', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => seatHolds(w, run, i));
    await w.down(4, 5, 6);                                                     // three seats: from before the close through the expiry
    await Promise.all([0, 1, 2, 3].map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = [0, 1, 2, 3].map((i) => seatHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.seats[0].stakes();
    const opened = await w.seats[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { voidedFirst, said4, beforeDown, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      seat0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 1, seats 4-6 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no seat settled the hold: ${facts.msatBack} back to the player`);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 1, seats 4-6 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    await w.down(4, 5, 6);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, seats: [0, 1, 2, 3].map((i) => seatHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, seats 4-6 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a seat keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

// PATH 1 WITH SEATS 3, 4 AND 5 DOWN FROM BEFORE THE CLOSE THROUGH THE EXPIRY
// (M3.3-34, measured before any change). The seats 4-6 order settled because
// seats 3 and 4 each held five shares; this down-set takes both of them down and
// keeps the committee at three down: seats 0, 1, 2 and 6 stay up.
test('5 of 7, a hold, path 1, seats 3-5 down from before the close through the hold\'s expiry - measured: where the stake goes', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => seatHolds(w, run, i));
    await w.down(3, 4, 5);                                                     // both five-share seats and one more
    const up = [0, 1, 2, 6];
    await Promise.all(up.map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = up.map((i) => seatHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.seats[0].stakes();
    const opened = await w.seats[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { voidedFirst, said4, beforeDown, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      seat0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 1, seats 3-5 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no seat settled the hold: ${facts.msatBack} back to the player`);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 1, seats 3-5 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.seats[4].port, m)));
    await wait(2000);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => seatHolds(w, run, i));
    await w.down(3, 4, 5);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, beforeDown, now, closed, seats: [0, 1, 2, 6].map((i) => seatHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, seats 3-5 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a seat keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

// PATH 2 WITH SEAT 4 DOWN FROM ITS REFUSAL THROUGH THE EXPIRY (M3.3-34, the order
// TASKBOOK lists: seats 0-3 ENTRY_VOID on a real outage; seat 4 alone up, a LATE
// first mark (1500) to it - its forward lost; then every seat back EXCEPT seat 4,
// which goes down right after refusing the late mark and stays down).
async function pathTwoSeatFourDown(w, run) {
  const voidedFirst = await voidAtZeroToThree(w, run);
  await w.back(4);
  await w.down(0, 1, 2, 3);                                                   // seat 4 alone: its forward goes nowhere
  const said4 = [];
  for (const m of run.late) said4.push(answer(await say(w.seats[4].port, m)));
  await wait(1000);
  const seat4 = seatHolds(w, run, 4);
  const lateAt4 = !!w.seats[4].round.startForfeit(run.eid);
  await w.down(4);                                                            // from its refusal through the expiry
  await w.back(0, 1, 2, 3, 5, 6);
  await wait(1000);
  return { voidedFirst, said4, lateAt4, seat4BeforeDown: seat4 };
}

test('5 of 7, a hold, path 2, seat 4 down from its refusal through the hold\'s expiry - ruled limit: no seat up holds the proof, the outage-VOID refund stands: the hold comes back to the player, 98000 msat, pool 0', async () => {
  const w = await sevenSeats('hold');
  try {
    const run = await seatWithTwoFirstMarks(w, 'hold');
    const setup = await pathTwoSeatFourDown(w, run);
    const up = [0, 1, 2, 3, 5, 6];
    const winner = await playWinner(w, up);
    const beforeClose = up.map((i) => seatHolds(w, run, i));
    await Promise.all(up.map((i) => say(w.seats[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = up.map((i) => seatHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.seats[0].stakes();
    const opened = await w.seats[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { ...setup, beforeClose, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      seat0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 2, seat 4 down from its refusal):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.lateAt4, true, 'seat 4 kept no late first mark: not the case the test names');
    // RULED (2026-09-13): the protocol's limit. A second first mark only the down
    // seat ever saw cannot be proven - no seat up holds the proof, so no seat can
    // replay a FORFEIT; the lost forward and seat 4 down are seat-side, not the
    // player's doing, and the operator must not profit from them. The outage-VOID
    // refund stands: the hold comes back to the player, the pool gets nothing.
    assert.ok(facts.atClose.every((x) => !x.proof), 'a seat up holds the proof: not the case the ruling covers');
    assert.deepEqual(h.settled, Array(7).fill(0), 'a seat settled a hold no seat up can prove forfeited');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'a seat cancelled the hold');
    assert.equal(facts.msatBack, `${NET} at the hold's expiry`);
    assert.equal(facts.msatToPool, '0');
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 2, seat 4 down from its refusal through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSeats('lock');
  try {
    const run = await seatWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSeatFourDown(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, seats: [0, 1, 2, 3, 5, 6].map((i) => seatHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2, seat 4 down from its refusal):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'seats 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.lateAt4, true, 'seat 4 kept no late first mark: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a seat keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});
