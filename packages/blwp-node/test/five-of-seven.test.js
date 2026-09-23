// TWO FIRST MARKS ON A FIVE-OF-SEVEN COMMITTEE (M3.3-34, ruled 2026-09-13).
//
// The same ruling as 2 of 2: two different first marks signed by the entry's
// session key are §13B's portable proof, and they FORFEIT with no refund - no
// signed result made up, no agreed run that never happened. On a hold the stake
// does not come back to that player (0 msat); on a lock only the player's own
// expiry refund, never a committee refund; and a signer node down at the close or past
// the hold's expiry does not hand the stake back.
//
// SEVEN LIVE DAEMONS, each on its own store and port, each able to go down and
// come back. THE ORDER: signer nodes 4-6 down while the on-time first mark (60) reaches
// signer node 0, which forwards it to 1-3 (four receipts, one short of five); 4-6 back;
// a DIFFERENT on-time first mark (30) to signer node 4, which forwards it to 5 and 6
// (three receipts). Neither mark can reach five, and signer nodes 0-3 hold the pair.
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort } from './lock-fixture.js';
import { paidPort, contractFor, say, wait, opts, rand, b32, secretScalar, STAKE, joinAndPlay, WINNER, LOSER,
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

/** Seven live signer nodes on one round: on holds (`hold`) or on stake locks with their own claim key (`lock`). */
async function sevenSignerNodes(custody) {
  const holdPorts = Array.from({ length: 7 }, () => paidPort());
  const locks = custody === 'lock' ? lockPort() : null;
  const dbs = Array.from({ length: 7 }, () => openStore(':memory:'));
  const mk = (i, port = 0) => serve(dbs[i], { port, ...opts, finality: { everyMs: 100 },
    ...(custody === 'hold' ? { lightning: holdPorts[i] } : { stakeLocks: locks, poolCurve: curve }) });
  const signerNodes = [];
  for (let i = 0; i < 7; i++) signerNodes.push(await mk(i));
  const ports = signerNodes.map((d) => d.port);
  const up = new Set([0, 1, 2, 3, 4, 5, 6]);
  const wire = () => {
    for (const i of up) {
      const there = ports.filter((_, j) => j !== i).map((p) => `http://127.0.0.1:${p}`);
      const d = signerNodes[i];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const c = { ...contractFor(signerNodes.map((d) => d.round.pubkey), BigInt(WINDOW), ports.map((p) => `http://127.0.0.1:${p}`)),
    ...(custody === 'lock' ? { custody: 'FEDERATION', federationId: TEST_FEDERATION_ID } : {}) };
  const rid = roundId(c);
  for (const d of signerNodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  if (custody === 'lock') for (let pass = 0; pass < 2; pass++) for (const d of signerNodes) await d.dkg.run(c.nodes);
  return {
    signerNodes, holdPorts, locks, c, rid, up,
    async down(...is) { for (const i of is) { await signerNodes[i].close(); up.delete(i); } },
    async back(...is) { for (const i of is) { signerNodes[i] = await mk(i, ports[i]); up.add(i); } wire(); },
    // A PARTITION BETWEEN SIGNER NODES THAT ARE UP: each named signer node's peers point where
    // nothing listens - its forwards and receipts are lost - until heal().
    cut(...is) {
      const dead = [1, 2, 3, 4, 5, 6].map((p) => `http://127.0.0.1:${p}`);
      for (const i of is) { const d = signerNodes[i]; d.verifier.peers = dead; d.payouts.peers = dead; d.preimages.peers = dead; d.dkg.peers = dead; }
    },
    heal() { wire(); },
    // A PARTITION BETWEEN TWO GROUPS OF SIGNER NODES THAT ARE UP: each side's links to the
    // other point where nothing listens (every peer list), the rest untouched.
    partition(a, b) {
      const blocked = (i, j) => (a.includes(i) && b.includes(j)) || (b.includes(i) && a.includes(j));
      for (const i of up) {
        const there = ports.map((p, j) => (j === i ? null : blocked(i, j) ? `http://127.0.0.1:${j + 1}` : `http://127.0.0.1:${p}`)).filter(Boolean);
        const d = signerNodes[i]; d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
      }
    },
    async close() { for (const i of [...up]) { try { await signerNodes[i].close(); } catch { /* down */ } } },
  };
}

/** The player: dealt 5 of 7, joined at all seven with its stake seen (a hold, or a lock); two different on-time first marks. */
async function joinWithTwoFirstMarks(w, custody) {
  const preimage = secretScalar();
  const e = rand(32);
  const session = ed25519.utils.randomSecretKey();
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: LOSER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: NEEDED, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  // AND ITS FEE LOCK (2026-09-21). The test federation is a legal one now - no base fee, as §22A requires -
  // so a lock round's gate mints fee locks, and the entry door refuses an entry that brings none: "its stake
  // would not be counted, and it would block the round's settlement". That refusal was this file's whole red
  // (409 !== 201 at `/entry`, before a mark was ever made). The production shape is an entry arriving with
  // the 2% already locked to H(F), which is what `first-mark.test.js` builds too.
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: LOSER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: LOSER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: custody === 'lock' ? feeSecret : new Uint8Array(32),
    stakeLockOutpoint: custody === 'lock' ? outpoint : { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: custody === 'lock' ? feeOutpoint : { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: custody === 'lock' ? b32(0x9a) : new Uint8Array(32),
  };
  const eid = entryId(entry);
  let fields = null, feeFields = null;
  if (custody === 'lock') {
    fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
      claimPk: w.signerNodes[0].dkg.signerNodeFor(w.c.nodes).pool.groupPublicKey, refundPk: refundKeyOf(LOSER.key), expiration: w.locks.height + 200 };
    await w.locks.put(outpoint, fields);
    feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
      claimPk: w.signerNodes[0].dkg.signerNodeFor(w.c.nodes).pool.groupPublicKey, refundPk: refundKeyOf(LOSER.key),
      expiration: w.locks.height + 200 };
    await w.locks.put(feeOutpoint, feeFields);
  }
  for (const d of w.signerNodes) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    if (custody === 'hold') {
      assert.equal((await fetch(`${base}/invoice?entry=${toHex(eid)}`)).status, 200);
      const seen = await fetch(`${base}/stake?entry=${toHex(eid)}`);
      assert.equal(seen.status, 200, await seen.text());
    } else {
      const l = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      assert.equal(l.status, 201, await l.text());
      const fl = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      assert.equal(fl.status, 201, await fl.text());
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
  // then a mark at PAST chaining to it - a signer node holding that first mark short of
  // its receipts, the signer nodes it was offered to down, records ENTRY_VOID. And a LATE
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

/** Signer nodes 4-6 down; the first mark to signer node 0 (forwarded to 1-3); 4-6 back; a different one to signer node 4 (forwarded to 5, 6). */
async function twoFirstMarks(w, run) {
  await w.down(4, 5, 6);
  const said0 = [];
  for (const m of run.first) said0.push(answer(await say(w.signerNodes[0].port, m)));
  await wait(1500);
  await w.back(4, 5, 6);
  const said4 = [];
  for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
  await wait(3000);
  return { said0, said4, proof: w.signerNodes.map((d) => d.round.equivocation(w.rid, run.eid).length),
    holdsFirst: w.signerNodes.map((d) => (d.round.firstMarkHeld(w.rid, run.eid) ? 1 : 0)) };
}

/**
 * THE WINNER, joined at all seven signer nodes first and then played at each - the
 * fixture's joinAndPlay signer nodes and plays one signer node at a time, and on seven signer nodes a
 * first mark forwarded by an earlier signer node can reach a later one after it is
 * joined: measured, its batch then answered '0' (round.batch: a repeat writes no
 * tick), not the 1320 joinAndPlay requires. Here each signer node's batch answer is
 * recorded - 1320 fresh or 0 already held by forward - and every signer node must
 * receipt the winner's mark.
 */
async function playWinner(w, signerNodesUp = null) {
  const ds = signerNodesUp ? signerNodesUp.map((i) => w.signerNodes[i]) : w.signerNodes;      // the signer nodes that are up
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
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
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
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
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES, 'a signer node did not receipt the winner\'s mark');
  }
  return { eid, preimage, batches };
}

const stateAt = (w, run) => w.signerNodes.map((d, i) => {
  if (!w.up.has(i)) return 'down';
  const nq = d.round.noQuorum(run.eid);
  return `${nq ? nq.outcome : 'none'}/${d.round.results(w.rid, run.eid).length}`;
});
const holds = (w, hash) => ({ settled: w.holdPorts.map((p) => p.settled.filter((s) => s.paymentHash === hash).length),
  cancelled: w.holdPorts.map((p) => p.cancelled.filter((s) => s.paymentHash === hash).length) });

test('5 of 7, a hold: two first marks, every signer node up at the close - FORFEIT at all seven with no signed result, and the hold SETTLED into the pool, never back to the player', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const before = await twoFirstMarks(w, run);
    const winner = await playWinner(w);
    const winnerHash = toHex(sha256(winner.preimage));
    await Promise.all(w.signerNodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const decided = () => w.signerNodes.every((d) => d.round.noQuorum(run.eid))
      && w.signerNodes.filter((d) => resultFinality(d.round, w.rid, winner.eid).state === 'FINAL').length >= NEEDED;
    for (let t = Date.now(); Date.now() - t < 30000 && !decided(); await wait(250));
    for (let t = Date.now(); Date.now() - t < 20000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const m = await w.signerNodes[0].stakes();
    const row = ((m.table && m.table.table) || []).find((r) => toHex(r.pubkey) === toHex(WINNER.key));
    const facts = { before, signerNodes: stateAt(w, run), hold: holds(w, run.paymentHash), winnerHold: holds(w, winnerHash),
      winnerFinal: w.signerNodes.filter((d) => resultFinality(d.round, w.rid, winner.eid).state === 'FINAL').length,
      tableAt0: { pool: m.table ? String(m.table.pool) : null, winnerMsat: row ? String(row.amountMsat) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : (m.ok === false ? String(m.why).slice(0, 80) : null) } };
    console.log('  FACTS (5 of 7, hold, all up):', JSON.stringify(facts));
    assert.deepEqual(facts.signerNodes, Array(7).fill('FORFEIT/0'), 'not FORFEIT with no signed result at every signer node');
    assert.deepEqual(facts.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(facts.hold.settled.some((n) => n > 0), 'no signer node settled the two-first-marks hold: it expires back to the player');
    assert.ok(facts.winnerHold.cancelled.some((n) => n > 0), 'the winner\'s own hold was not cancelled back to it');
    assert.equal(facts.tableAt0.winnerMsat, String(2n * (STAKE - entryFeeMsat(STAKE))), 'the forfeited stake does not reach the winner in the table');
  } finally { await w.close(); }
});

test('5 of 7, a hold: two first marks, and signer nodes 4-6 down from before the close through the hold\'s expiry - the four signer nodes up still FORFEIT and SETTLE the hold, nothing goes back to the player', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const before = await twoFirstMarks(w, run);
    await playWinner(w);
    await w.down(4, 5, 6);                                                     // three signer nodes: only four shares are up
    await Promise.all([0, 1, 2, 3].map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 20000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const opened = await w.signerNodes[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { before, signerNodes: stateAt(w, run), hold: holds(w, run.paymentHash),
      custodyRows: w.signerNodes.map((d, i) => (w.up.has(i) ? ((d.round.hold(run.eid) || {}).state || null) : 'down')),
      signerNode0Opens: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 120) };
    console.log('  FACTS (5 of 7, hold, 4-6 down through the expiry):', JSON.stringify(facts));
    assert.deepEqual(facts.signerNodes.slice(0, 4), Array(4).fill('FORFEIT/0'), 'a signer node that is up did not FORFEIT with no signed result');
    assert.deepEqual(facts.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(facts.hold.settled.slice(0, 4).some((n) => n > 0), 'no signer node that is up settled the hold: it expires back to the player');
  } finally { await w.close(); }
});

test('5 of 7, a stake lock: two first marks - FORFEIT at all seven, no signer node signs the refund, no forfeit kept, the lock held (back only by the player\'s own expiry refund)', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const before = await twoFirstMarks(w, run);
    await Promise.all(w.signerNodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (let t = Date.now(); Date.now() - t < 30000 && !w.signerNodes.every((d) => d.round.noQuorum(run.eid)); await wait(250));
    await wait(1000);
    const signerNodesAfter = stateAt(w, run);
    const doors = [];
    for (const d of w.signerNodes) doors.push((await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status);
    const facts = { before, signerNodes: signerNodesAfter, doors, forfeitKept: w.signerNodes.map((d) => (d.round.forfeit(run.eid) ? 1 : 0)),
      lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (5 of 7, lock):', JSON.stringify(facts));
    assert.deepEqual(facts.signerNodes, Array(7).fill('FORFEIT/0'), 'not FORFEIT with no signed result at every signer node');
    assert.deepEqual(facts.doors, Array(7).fill(409), 'a signer node signs the refund of the lock to the player');
    assert.deepEqual(facts.forfeitKept, Array(7).fill(0), 'a signer node keeps a refund of the lock');
    assert.equal(facts.lockHeld, true);
  } finally { await w.close(); }
});

// ---- THE OUTAGE-VOID ORDERS ON 5 OF 7 (ruled: two first marks is FORFEIT even
// after a real outage made signer nodes record ENTRY_VOID; on 5 of 7 one refusing signer node
// does not block a refund - five signatures form it). Measured, not read off 2 of 2.

/** Signer nodes 4-6 down; the first mark (60) and a mark past the start line to each of signer nodes 0-3: a real outage, they record ENTRY_VOID. */
async function voidAtZeroToThree(w, run) {
  await w.down(4, 5, 6);
  for (const i of [0, 1, 2, 3]) for (const m of [...run.first, ...run.past]) await say(w.signerNodes[i].port, m);
  for (let t = Date.now(); Date.now() - t < 10000 && [0, 1, 2, 3].some((i) => !w.signerNodes[i].round.entryVoid(run.eid)); await wait(200));
  return [0, 1, 2, 3].filter((i) => w.signerNodes[i].round.entryVoid(run.eid)).length;
}

/**
 * WHAT THE COMMITTEE WOULD DO WITH THE STAKE LOCK NOW, over the signer nodes that are
 * up: how many recorded the Void, how many hold both marks, how many would
 * commit to the refund (POST /forfeit-commit, 200 = would sign), and every
 * refund door (GET /forfeit, 200 = five signatures formed, a refund).
 */
async function refundNow(w, run) {
  const q = `round=${toHex(w.rid)}&entry=${toHex(run.eid)}`;
  const up = [...w.up].sort((a, b) => a - b);
  const count = (f) => up.filter((i) => f(w.signerNodes[i])).length;
  const voids = count((d) => !!d.round.entryVoid(run.eid));
  const both = count((d) => d.round.provenTwoFirstMarks(w.rid, run.eid));
  const commits = [];
  for (const i of up) commits.push((await fetch(`http://127.0.0.1:${w.signerNodes[i].port}/forfeit-commit?${q}`, { method: 'POST' })).status);
  const doors = [];
  for (const i of up) doors.push((await fetch(`http://127.0.0.1:${w.signerNodes[i].port}/forfeit?${q}`)).status);
  return { up: up.length, voids, both, wouldSign: commits.filter((s) => s === 200).length, commits, doors,
    voidsAfterDoors: count((d) => !!d.round.entryVoid(run.eid)), kept: count((d) => !!d.round.forfeit(run.eid)),
    lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}
const NET = STAKE - entryFeeMsat(STAKE);

/** Each signer node's own record of the run: the result it signed (outcome/score), its finality, its no-quorum reason. */
const recordsOf = (w, run) => ({
  signed: w.signerNodes.map((d, i) => {
    if (!w.up.has(i)) return 'down';
    const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
    if (!mine) return null;
    const p = decodePlayerResult(splitSignedResult(mine.bytes).body);
    return `${p.outcome}/${p.score}`;
  }),
  finality: w.signerNodes.map((d, i) => (w.up.has(i) ? resultFinality(d.round, w.rid, run.eid).state : 'down')),
  noQuorumWhy: w.signerNodes.map((d, i) => { const nq = w.up.has(i) ? d.round.noQuorum(run.eid) : null; return nq ? String(nq.why).slice(0, 90) : null; }),
});

/** A lock round after every signer node that is up closes and the window passes: each signer node's record, and every refund door again. */
async function lockAfterClose(w, run) {
  const up = [...w.up].sort((a, b) => a - b);
  await Promise.all(up.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
  for (let t = Date.now(); Date.now() - t < 20000
    && !up.every((i) => w.signerNodes[i].round.noQuorum(run.eid) || w.signerNodes[i].round.results(w.rid, run.eid).length); await wait(250));
  await wait(WINDOW + 1500);
  const q = `round=${toHex(w.rid)}&entry=${toHex(run.eid)}`;
  const doors = [];
  for (const i of up) doors.push((await fetch(`http://127.0.0.1:${w.signerNodes[i].port}/forfeit?${q}`)).status);
  return { signerNodes: stateAt(w, run), ...recordsOf(w, run), doors, kept: up.filter((i) => !!w.signerNodes[i].round.forfeit(run.eid)).length,
    lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}

/** On a hold: every signer node closes, then what each decided, how many hold both marks, and where the hold went. */
async function holdAfterClose(w, run, winner) {
  await Promise.all(w.signerNodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
  for (let t = Date.now(); Date.now() - t < 30000 && !w.signerNodes.every((d) => d.round.noQuorum(run.eid)); await wait(250));
  for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
  await wait(1500);
  const h = holds(w, run.paymentHash);
  return { signerNodes: stateAt(w, run), ...recordsOf(w, run), voids: w.signerNodes.filter((d) => d.round.entryVoid(run.eid)).length,
    both: w.signerNodes.filter((d) => d.round.provenTwoFirstMarks(w.rid, run.eid)).length, hold: h,
    winnerHold: holds(w, toHex(sha256(winner.preimage))),
    msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry` };
}

test('5 of 7, a stake lock, path 1: signer nodes 0-3 record ENTRY_VOID on a real outage, then a different on-time first mark reaches signer node 4 - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a signer node keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} signer nodes would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 2: signer nodes 0-3 record ENTRY_VOID, then a late first mark reaches signer node 4 alone and its forward is lost - no five refund signatures form, no refund door answers 2xx, the lock held', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4);
    await w.down(0, 1, 2, 3);                                                   // signer node 4 alone: its forward goes nowhere
    const said4 = [];
    for (const m of run.late) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(1000);
    await w.back(0, 1, 2, 3, 5, 6);
    await wait(1000);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, lateAt4: !!w.signerNodes[4].round.startForfeit(run.eid), voidAt4: !!w.signerNodes[4].round.entryVoid(run.eid),
      proofAt4: w.signerNodes[4].round.provenTwoFirstMarks(w.rid, run.eid), now, closed, msatBack: now.kept || closed.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    // PICK A (ruled 2026-09-13): signer node 4, back, records the same ENTRY_VOID from the
    // full receipt set, so the player's late first mark reaching it is the second
    // first mark - refused as such and the pair kept - not a late start.
    assert.equal(facts.voidAt4, true, 'signer node 4 did not record the Void from the full receipts: not the case the test names');
    assert.ok(said4.some((a) => /FORFEIT: the player signed another first mark/.test(a)), `signer node 4 did not refuse the late mark as a second first mark: ${JSON.stringify(said4)}`);
    assert.equal(facts.proofAt4, true, 'signer node 4 kept no proof of two first marks');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx - five signatures formed: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, 'a signer node keeps a refund of the lock');
    assert.ok(now.wouldSign < NEEDED, `${now.wouldSign} signer nodes would sign the refund: five form it`);
    assert.equal(now.lockHeld, true);
    assert.ok(!closed.doors.some((s) => s >= 200 && s < 300), `after the close a refund door answered 2xx: ${JSON.stringify(closed.doors)}`);
    assert.equal(closed.kept, 0, 'after the close a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a hold, path 1: signer nodes 0-3 record ENTRY_VOID, then a different on-time first mark reaches signer node 4 - FORFEIT, the hold SETTLED into the pool, 0 msat back', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    console.log('  FACTS (5 of 7, hold, path 1):', JSON.stringify({ voidedFirst, said4, after }));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no signer node settled the hold: it expires back to the player - ${JSON.stringify(after.signerNodes)}`);
  } finally { await w.close(); }
});

test('5 of 7, a hold, path 2: signer nodes 0-3 record ENTRY_VOID, then a late first mark reaches signer node 4 alone and its forward is lost - FORFEIT, the hold SETTLED into the pool, 0 msat back', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4);
    await w.down(0, 1, 2, 3);
    const said4 = [];
    for (const m of run.late) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(1000);
    await w.back(0, 1, 2, 3, 5, 6);
    await wait(1000);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    console.log('  FACTS (5 of 7, hold, path 2):', JSON.stringify({ voidedFirst, said4, lateAt4: !!w.signerNodes[4].round.startForfeit(run.eid), after }));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no signer node settled the hold: it expires back to the player - ${JSON.stringify(after.signerNodes)}`);
  } finally { await w.close(); }
});

// PATH 1 ON A HOLD, AND THE ONE SIGNER NODE THAT DECIDED FORFEIT GOES DOWN. Measured
// before this test: in path 1 six signer nodes sign a FAILED result (they took the first
// mark late and carry a transcript) that never agrees 5 of 7, and only signer node 4 -
// which refused the second mark - decides FORFEIT and settles. Here signer node 4 is
// down from before the close through the hold's expiry: does any signer node still keep
// the stake from going back to the player?
test('5 of 7, a hold, path 1, and signer node 4 down from before the close through the hold\'s expiry - the hold still SETTLED into the pool, 0 msat back', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    await w.down(4);                                                           // the signer node that refused the second mark
    const up = [...w.up];
    await Promise.all(up.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const h = holds(w, run.paymentHash);
    const facts = { voidedFirst, said4, signerNodes: stateAt(w, run), ...recordsOf(w, run),
      both: up.filter((i) => w.signerNodes[i].round.provenTwoFirstMarks(w.rid, run.eid)).length, hold: h,
      winnerHold: holds(w, toHex(sha256(winner.preimage))),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry` };
    console.log('  FACTS (5 of 7, hold, path 1, signer node 4 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no signer node settled the hold: ${facts.msatBack} back to the player - ${JSON.stringify(facts.signed)}`);
  } finally { await w.close(); }
});

// PATH 1 WITH SIGNER NODES 4-6 DOWN FROM BEFORE THE CLOSE THROUGH THE HOLD'S EXPIRY
// (M3.3-34, measured before any change). The reading to test: the proof formed at
// signer node 4; signer nodes 0-3 learned it by pulling and never gathered shares, so with 4-6
// down they hold 4 of the 5 shares a settle needs and the hold expires back.

/** What signer node `i` actually holds for the entry: shares it can open (its own + kept envelopes), the proof, its decision, its custody row. */
const signerNodeHolds = (w, run, i) => {
  const d = w.signerNodes[i];
  const nq = d.round.noQuorum(run.eid);
  const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
  return { signerNode: i, shares: 1 + d.round.heldShares(run.eid).length, proof: d.round.provenTwoFirstMarks(w.rid, run.eid),
    decided: nq ? nq.outcome : null, signed: mine ? (() => { const p = decodePlayerResult(splitSignedResult(mine.bytes).body); return `${p.outcome}/${p.score}`; })() : null,
    voided: !!d.round.entryVoid(run.eid), custody: (d.round.hold(run.eid) || {}).state || null };
};

test('5 of 7, a hold, path 1, signer nodes 4-6 down from before the close through the hold\'s expiry - measured: where the stake goes', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i));
    await w.down(4, 5, 6);                                                     // three signer nodes: from before the close through the expiry
    await Promise.all([0, 1, 2, 3].map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = [0, 1, 2, 3].map((i) => signerNodeHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.signerNodes[0].stakes();
    const opened = await w.signerNodes[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { voidedFirst, said4, beforeDown, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      signerNode0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 1, signer nodes 4-6 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no signer node settled the hold: ${facts.msatBack} back to the player`);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 1, signer nodes 4-6 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    await w.down(4, 5, 6);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, now, closed, signerNodes: [0, 1, 2, 3].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, signer nodes 4-6 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

// PATH 1 WITH SIGNER NODES 3, 4 AND 5 DOWN FROM BEFORE THE CLOSE THROUGH THE EXPIRY
// (M3.3-34, measured before any change). The signer nodes 4-6 order settled because
// signer nodes 3 and 4 each held five shares; this down-set takes both of them down and
// keeps the committee at three down: signer nodes 0, 1, 2 and 6 stay up.
test('5 of 7, a hold, path 1, signer nodes 3-5 down from before the close through the hold\'s expiry - measured: where the stake goes', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const winner = await playWinner(w);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i));
    await w.down(3, 4, 5);                                                     // both five-share signer nodes and one more
    const up = [0, 1, 2, 6];
    await Promise.all(up.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = up.map((i) => signerNodeHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.signerNodes[0].stakes();
    const opened = await w.signerNodes[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { voidedFirst, said4, beforeDown, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      signerNode0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 1, signer nodes 3-5 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(h.settled.some((n) => n > 0), `no signer node settled the hold: ${facts.msatBack} back to the player`);
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 1, signer nodes 3-5 down from before the close through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const said4 = [];
    for (const m of run.other) said4.push(answer(await say(w.signerNodes[4].port, m)));
    await wait(2000);
    const beforeDown = [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i));
    await w.down(3, 4, 5);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { voidedFirst, said4, beforeDown, now, closed, signerNodes: [0, 1, 2, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 1, signer nodes 3-5 down through the expiry):', JSON.stringify(facts));
    assert.equal(voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

// PATH 2 WITH SIGNER NODE 4 DOWN FROM ITS REFUSAL THROUGH THE EXPIRY (M3.3-34, the order
// TASKBOOK lists: signer nodes 0-3 ENTRY_VOID on a real outage; signer node 4 alone up, a LATE
// first mark (1500) to it - its forward lost; then every signer node back EXCEPT signer node 4,
// which goes down right after refusing the late mark and stays down).
async function pathTwoSignerNodeFourDown(w, run) {
  const voidedFirst = await voidAtZeroToThree(w, run);
  await w.back(4);
  await w.down(0, 1, 2, 3);                                                   // signer node 4 alone: its forward goes nowhere
  const said4 = [];
  for (const m of run.late) said4.push(answer(await say(w.signerNodes[4].port, m)));
  await wait(1000);
  const signerNode4 = signerNodeHolds(w, run, 4);
  const lateAt4 = !!w.signerNodes[4].round.startForfeit(run.eid);
  await w.down(4);                                                            // from its refusal through the expiry
  await w.back(0, 1, 2, 3, 5, 6);
  await wait(1000);
  return { voidedFirst, said4, lateAt4, signerNode4BeforeDown: signerNode4 };
}

test('5 of 7, a hold, path 2, signer node 4 down from its refusal through the hold\'s expiry - ruled limit: no signer node up holds the proof, the outage-VOID refund stands: the hold comes back to the player, 98000 msat, pool 0', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    const up = [0, 1, 2, 3, 5, 6];
    const winner = await playWinner(w, up);
    const beforeClose = up.map((i) => signerNodeHolds(w, run, i));
    await Promise.all(up.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
    await wait(3 * WINDOW + 3000);
    for (let t = Date.now(); Date.now() - t < 15000 && !holds(w, run.paymentHash).settled.some((n) => n); await wait(250));
    await wait(1500);
    const atClose = up.map((i) => signerNodeHolds(w, run, i));
    const h = holds(w, run.paymentHash);
    const m = await w.signerNodes[0].stakes();
    const opened = await w.signerNodes[0].preimages.open({ roundId: w.rid, entryId: run.eid, needed: NEEDED });
    const facts = { ...setup, beforeClose, atClose, hold: h, winnerHold: holds(w, toHex(sha256(winner.preimage))),
      poolAt0: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 90) : null, pool: m.table ? String(m.table.pool) : null,
        owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
      signerNode0OpensAfter: opened.ok ? `OPENED with ${opened.held}` : String(opened.why).slice(0, 160),
      msatBack: h.settled.some((n) => n) ? '0' : h.cancelled.some((n) => n) ? String(NET) : `${NET} at the hold's expiry`,
      msatToPool: h.settled.some((n) => n) ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, hold, path 2, signer node 4 down from its refusal):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.lateAt4, true, 'signer node 4 kept no late first mark: not the case the test names');
    // RULED (2026-09-13): the protocol's limit. A second first mark only the down
    // signer node ever saw cannot be proven - no signer node up holds the proof, so no signer node can
    // replay a FORFEIT; the lost forward and signer node 4 down are signer node-side, not the
    // player's doing, and the operator must not profit from them. The outage-VOID
    // refund stands: the hold comes back to the player, the pool gets nothing.
    assert.ok(facts.atClose.every((x) => !x.proof), 'a signer node up holds the proof: not the case the ruling covers');
    assert.deepEqual(h.settled, Array(7).fill(0), 'a signer node settled a hold no signer node up can prove forfeited');
    assert.deepEqual(h.cancelled, Array(7).fill(0), 'a signer node cancelled the hold');
    assert.equal(facts.msatBack, `${NET} at the hold's expiry`);
    assert.equal(facts.msatToPool, '0');
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, path 2, signer node 4 down from its refusal through the lock\'s expiry - measured: no refund forms, the lock held', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signerNodes: [0, 1, 2, 3, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, path 2, signer node 4 down from its refusal):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.lateAt4, true, 'signer node 4 kept no late first mark: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

// A LOCK WITH RECEIPTS LOST BETWEEN SIGNER NODES THAT ARE UP (M3.3-34, the order TASKBOOK
// lists): five signer nodes each holding the on-time first mark and each short of five
// receipts would all record the Void and could sign a refund at once, before
// their close pulls the proof. Every signer node is up; their links to each other are
// cut while the player's first mark (60) and a mark past the line (1500) reach
// signer nodes 0-4 - each keeps its own receipt only, its six offers unanswered. Then the
// links heal and a DIFFERENT on-time first mark (30) reaches signer node 5.

/** Receipts each signer node holds for each of the entry's marks, in chain order. */
const receiptsAt = (w, run) => w.signerNodes.map((d, i) => (w.up.has(i) ? d.round.markIds(w.rid, run.eid).map((id) => d.round.receiptCount(id)) : 'down'));

async function voidAtZeroToFourCut(w, run, { second = true } = {}) {   // second: the different first mark to signer node 5
  w.cut(0, 1, 2, 3, 4, 5, 6);
  for (const i of [0, 1, 2, 3, 4]) for (const m of [...run.first, ...run.past]) await say(w.signerNodes[i].port, m);
  for (let t = Date.now(); Date.now() - t < 10000 && [0, 1, 2, 3, 4].some((i) => !w.signerNodes[i].round.entryVoid(run.eid)); await wait(200));
  const receiptsCut = receiptsAt(w, run);
  const voided = [0, 1, 2, 3, 4].filter((i) => w.signerNodes[i].round.entryVoid(run.eid)).length;
  w.heal();
  const said5 = [];
  if (second) for (const m of run.other) said5.push(answer(await say(w.signerNodes[5].port, m)));
  await wait(2000);
  return { voided, receiptsCut, said5, receiptsHealed: receiptsAt(w, run),
    proof: w.signerNodes.map((d) => (d.round.provenTwoFirstMarks(w.rid, run.eid) ? 1 : 0)) };
}

test('5 of 7, a stake lock, receipts lost between signer nodes that are up: signer nodes 0-4 each record ENTRY_VOID, then a different on-time first mark reaches signer node 5 - measured: refund signatures, whether a committee refund forms, the lock', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost between up signer nodes):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx - five signatures formed');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a hold, receipts lost between signer nodes that are up: signer nodes 0-4 each record ENTRY_VOID, then a different on-time first mark reaches signer node 5 - measured: where the stake goes', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const setup = await voidAtZeroToFourCut(w, run);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    const facts = { ...setup, after, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)) };
    console.log('  FACTS (5 of 7, hold, receipts lost between up signer nodes):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no signer node settled the hold: ${after.msatBack} back to the player`);
  } finally { await w.close(); }
});

// RECEIPTS LOST, AND THE SIGNER NODE HOLDING THE PROOF UNREACHABLE FROM THE VOID SIGNER NODES
// WHEN THE REFUND IS ASKED (M3.3-34, the variant left open by cb63823): the
// receipts-lost order, then signer nodes 0-4 and signer node 5 cut off from each other (signer node 6
// reaches all) while the lock refund is asked; healed after.
test('5 of 7, a stake lock, receipts lost, and signer node 5 (the proof) unreachable from the Void signer nodes when the refund is asked - measured: refund signatures, whether a committee refund forms', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run);
    w.partition([0, 1, 2, 3, 4], [5]);
    const now = await refundNow(w, run);
    const proofAtRefund = w.signerNodes.map((d) => (d.round.provenTwoFirstMarks(w.rid, run.eid) ? 1 : 0));
    w.heal();
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, proofAtRefund, now, closed, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost, signer node 5 unreachable at the refund):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.equal(setup.proof[5], 1, 'signer node 5 does not hold the proof: not the case the test names');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300) && !closed.doors.some((s) => s >= 200 && s < 300), 'a refund door answered 2xx - five signatures formed');
    assert.equal(now.kept + closed.kept, 0, 'a signer node keeps a refund of the lock');
    assert.equal(closed.lockHeld, true);
  } finally { await w.close(); }
});

test('5 of 7, a hold, receipts lost, and signer node 5 (the proof) unreachable from the Void signer nodes for the same moment - measured: where the stake goes', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const setup = await voidAtZeroToFourCut(w, run);
    w.partition([0, 1, 2, 3, 4], [5]);
    await wait(3000);
    const proofInPartition = w.signerNodes.map((d) => (d.round.provenTwoFirstMarks(w.rid, run.eid) ? 1 : 0));
    w.heal();
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    const facts = { ...setup, proofInPartition, after, signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)) };
    console.log('  FACTS (5 of 7, hold, receipts lost, signer node 5 unreachable for the same moment):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(after.hold.cancelled, Array(7).fill(0), 'the two-first-marks hold was cancelled back to the player');
    assert.ok(after.hold.settled.some((n) => n > 0), `no signer node settled the hold: ${after.msatBack} back to the player`);
  } finally { await w.close(); }
});

// A GENUINE OUTAGE-VOID ON THE SAME TOPOLOGY (M3.3-34, the path Plan A must not
// break): receipts lost between signer nodes that are up, signer nodes 0-4 record ENTRY_VOID -
// and the player signs NO second first mark. No signer node holds a proof; the fast
// committee refund of the lock must still form.
test('5 of 7, a stake lock, receipts lost between signer nodes that are up, and no second first mark - a genuine outage-VOID: the fast committee refund still forms', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await voidAtZeroToFourCut(w, run, { second: false });
    const now = await refundNow(w, run);
    const facts = { ...setup, now, msatBackByCommittee: now.kept ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, receipts lost, a genuine outage-VOID):', JSON.stringify(facts));
    assert.equal(setup.voided, 5, 'signer nodes 0-4 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(setup.proof, Array(7).fill(0), 'a signer node holds a proof of two first marks: not the case the test names');
    assert.ok(now.doors.some((s) => s === 200), `the genuine outage-VOID's fast refund did not form: ${JSON.stringify(now.doors)}`);
    assert.ok(now.kept > 0, 'no signer node keeps the refund of a genuine outage-VOID');
  } finally { await w.close(); }
});

// ---- ENTRY_VOID ON 5 OF 7 (§16; M3.3-34, the slice after the lobby) ----
// A GENUINE OUTAGE, SIGNER NODES DOWN: signer nodes 4-6 down while the player's first mark
// (60) and a mark past the line (1500) reach signer nodes 0-3 - fewer than five signer nodes
// available, so the entry must be ENTRY_VOID (§16). Then signer nodes 4-6 come back and
// the player's client catches them up (the first mark and the mark past the
// line), as 2 of 2's "caught up late" case does. The player signed NO second
// first mark: nothing here is the player's doing. Measured: what each signer node
// records, and where the stake goes. Asserted: only the money the rule leaves no
// choice on - no signer node signs FAILED or DELIVERED for this entry, the hold never
// settles into the pool, the committee never claims the lock. Which VOID each
// signer node records is printed, not asserted.
async function outageCaughtUp(w, run) {
  const voidedFirst = await voidAtZeroToThree(w, run);
  await w.back(4, 5, 6);
  const caughtUp = {};
  for (const i of [4, 5, 6]) {
    caughtUp[i] = [];
    for (const m of [...run.first, ...run.past]) caughtUp[i].push(answer(await say(w.signerNodes[i].port, m)));
  }
  await wait(2000);
  return { voidedFirst, caughtUp, voids: w.signerNodes.map((d) => (d.round.entryVoid(run.eid) ? 1 : 0)),
    receipts: receiptsAt(w, run), proof: w.signerNodes.map((d) => (d.round.provenTwoFirstMarks(w.rid, run.eid) ? 1 : 0)) };
}
const signedOutcomes = (w, run) => w.signerNodes.map((d, i) => {
  if (!w.up.has(i)) return 'down';
  return d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome)
    .filter((o, k, a) => a.indexOf(o) === k).join('+') || null;
});

test('5 of 7, a hold, genuine outage-VOID: signer nodes 4-6 down, then caught up late - measured: what each signer node records, where the stake goes', slice2(), async () => {
  const w = await sevenSignerNodes('hold');
  try {
    const run = await joinWithTwoFirstMarks(w, 'hold');
    const setup = await outageCaughtUp(w, run);
    const winner = await playWinner(w);
    const after = await holdAfterClose(w, run, winner);
    const facts = { ...setup, after, signedOutcomes: signedOutcomes(w, run), signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)) };
    console.log('  FACTS (5 of 7, hold, genuine outage-VOID, caught up late):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.deepEqual(setup.proof, Array(7).fill(0), 'a signer node holds a proof of two first marks: not the case the test names');
    assert.ok(!facts.signedOutcomes.some((o) => o && /FAILED|DELIVERED/.test(o)), `a signer node signed a run for an entry that must VOID: ${JSON.stringify(facts.signedOutcomes)}`);
    assert.deepEqual(after.hold.settled, Array(7).fill(0), 'the stake of an entry that must VOID was settled into the pool');
  } finally { await w.close(); }
});

test('5 of 7, a stake lock, genuine outage-VOID: signer nodes 4-6 down, then caught up late - measured: what each signer node records, the refund doors', async () => {
  const w = await sevenSignerNodes('lock');
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await outageCaughtUp(w, run);
    const now = await refundNow(w, run);
    const closed = await lockAfterClose(w, run);
    const facts = { ...setup, now, closed, signedOutcomes: signedOutcomes(w, run), signerNodes: [0, 1, 2, 3, 4, 5, 6].map((i) => signerNodeHolds(w, run, i)),
      msatBackByCommittee: now.kept || closed.kept ? String(NET) : '0', lockMsat: closed.lockHeld ? String(NET) : '0' };
    console.log('  FACTS (5 of 7, lock, genuine outage-VOID, caught up late):', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'signer nodes 0-3 did not all record ENTRY_VOID: not the case the test names');
    assert.ok(!facts.signedOutcomes.some((o) => o && /FAILED|DELIVERED/.test(o)), `a signer node signed a run for an entry that must VOID: ${JSON.stringify(facts.signedOutcomes)}`);
  } finally { await w.close(); }
});

/** Why this test does not run in Step 1 of the THRESHOLD_LN disposal (see TASKBOOK). */
function slice2() { return { skip: "slice 2: the subject is the hold path (hold invoices on a Lightning port). It still runs at HEAD on a FEDERATION round given a Lightning port, so it is skipped, not moved to FEDERATION (RULED 2026-09-23); slice 2 deletes this test with the code" }; }
