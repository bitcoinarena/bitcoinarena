// THE FIVE-OF-SEVEN FIXTURE: seven live signer nodes on one stake-lock round and the helpers that drive them, shared
// by five-of-seven.test.js and five-of-seven-receipts-lost.test.js. Moved here unchanged when the file was split to fit
// the 180 s per-file cap (measured 2026-09-23: ten tests, 18-40 s each, ~220 s in one file).
import { testNow, skipTo } from './test-clock.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { contractFor, say, wait, opts, rand, b32, secretScalar, STAKE, joinAndPlay, WINNER, LOSER,
  RANDOMNESS, GENESIS_HASH, wordsAt, playFor, warmPlay, PLANTED_FIRST_MARK_DEADLINE, presentDay } from './window-fixture.js';
import { CLOCK } from './block-clock.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';
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
import { loaded, bedFrom } from './window-fixture.js';
import { hash as stateHash } from '../../core/src/state.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
export const WINDOW = 800;
export const NEEDED = 5;
export const PAST = PLANTED_FIRST_MARK_DEADLINE + 100;          // past the round's start line
export const curve = { ...feldmanGroup, tweakPoint };
export const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');

/** Seven live signer nodes on one round, on stake locks with their own claim key (`lock`: the one custody, §23.6). */
export async function sevenSignerNodes(custody, { endIn = null } = {}) {
  // A CHAIN THAT BONDS THE ROUND'S SEVEN (RULED 2026-09-25: a paying round opens only on a signer node that reads the
  // chain, and its beacon is that chain's). All seven are running daemons, so the round's claim key is their own live DKG.
  const slot = custody === 'lock' ? bondedChainSlot(lockPort()) : null;
  const locks = slot ? slot.port : null;
  const dbs = Array.from({ length: 7 }, () => openStore(':memory:'));
  const mk = (i, port = 0) => serve(dbs[i], { port, ...opts, finality: { everyMs: 100 },
    stakeLocks: locks, poolCurve: curve, ...(slot ? { chainFor: slot.chainFor, randomnessFor: slot.randomnessFor } : {}) });
  const signerNodes = [];
  for (let i = 0; i < 7; i++) signerNodes.push(await mk(i));
  const ports = signerNodes.map((d) => d.port);
  const up = new Set([0, 1, 2, 3, 4, 5, 6]);
  const wire = () => {
    for (const i of up) {
      const there = ports.filter((_, j) => j !== i).map((p) => `http://127.0.0.1:${p}`);
      const d = signerNodes[i];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const base = { ...contractFor(signerNodes.map((d) => d.round.pubkey), BigInt(WINDOW), ports.map((p) => `http://127.0.0.1:${p}`)),
    ...(custody === 'lock' ? { custody: 'FEDERATION', federationId: TEST_FEDERATION_ID } : {}) };
  // `endIn`: THE ROUND IN THE PRESENT, its contract end this many ms from now (§13C's result window opens at it).
  const drafted = endIn === null ? base : presentDay(base, testNow() + endIn);
  // ONLY THE FIELD THE CHAIN DICTATES (RULED 2026-09-25): the census root its bonds derive to; the round's times stand.
  const c = slot ? { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
    { endpoints: ports.map((p) => `ws://127.0.0.1:${p}`) }).censusRoot } : drafted;
  const rid = roundId(c);
  // THE ROUND'S OWN BEACON: the players seed their marks from it, as the signer nodes replay them.
  const beacon = slot ? slot.randomnessFor({ contract: c }) : null;
  for (const d of signerNodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  if (custody === 'lock') for (let pass = 0; pass < 2; pass++) for (const d of signerNodes) await d.dkg.run(c.nodes);
  return {
    signerNodes, locks, c, rid, up, randomness: beacon ? beacon.hash : RANDOMNESS,
    async down(...is) { for (const i of is) { await signerNodes[i].close(); up.delete(i); } },
    async back(...is) { for (const i of is) { signerNodes[i] = await mk(i, ports[i]); up.add(i); } wire(); },
    // A PARTITION BETWEEN SIGNER NODES THAT ARE UP: each named signer node's peers point where
    // nothing listens - its forwards and receipts are lost - until heal().
    cut(...is) {
      const dead = [1, 2, 3, 4, 5, 6].map((p) => `http://127.0.0.1:${p}`);
      for (const i of is) { const d = signerNodes[i]; d.verifier.peers = dead; d.stakeSecrets.peers = dead; d.dkg.peers = dead; }
    },
    heal() { wire(); },
    // A PARTITION BETWEEN TWO GROUPS OF SIGNER NODES THAT ARE UP: each side's links to the
    // other point where nothing listens (every peer list), the rest untouched.
    partition(a, b) {
      const blocked = (i, j) => (a.includes(i) && b.includes(j)) || (b.includes(i) && a.includes(j));
      for (const i of up) {
        const there = ports.map((p, j) => (j === i ? null : blocked(i, j) ? `http://127.0.0.1:${j + 1}` : `http://127.0.0.1:${p}`)).filter(Boolean);
        const d = signerNodes[i]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
      }
    },
    async close() { for (const i of [...up]) { try { await signerNodes[i].close(); } catch { /* down */ } } },
  };
}

/** The player: dealt 5 of 7, joined at all seven with its stake seen (a hold, or a lock); two different on-time first marks. */
export async function joinWithTwoFirstMarks(w, custody) {
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
    const l = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(l.status, 201, await l.text());
    const fl = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    assert.equal(fl.status, 201, await fl.text());
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const firstAt = (tick) => {
    const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < tick; t++) step(st, ...wordsAt(t));
    const b = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: tick }, (_, t) => wordsAt(t)), liquidations: [], loads: bedFrom(0) };
    const m = { roundId: w.rid, entryId: eid, tick, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: batchId(b), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
    return [encodeInputBatch(b), sign(m)];
  };
  // THE CHAIN PAST THE START LINE (the outage-VOID orders): the first mark at 60,
  // then a mark at PAST chaining to it - a signer node holding that first mark short of
  // its receipts, the signer nodes it was offered to down, records ENTRY_VOID. And a LATE
  // first mark at PAST, from nothing.
  const hashAt = (tick) => {
    const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < tick; t++) step(st, ...wordsAt(t));
    return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  };
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [], loads: bedFrom(0) };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashAt(60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: PAST - 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: PAST, stateHash: hashAt(PAST), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  return { eid, outpoint, paymentHash: toHex(sha256(preimage)), first: firstAt(60), other: firstAt(30),
    past: [encodeInputBatch(b2), sign(m2)], late: firstAt(PAST) };
}

/** Signer nodes 4-6 down; the first mark to signer node 0 (forwarded to 1-3); 4-6 back; a different one to signer node 4 (forwarded to 5, 6). */
export async function twoFirstMarks(w, run) {
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
export async function playWinner(w, signerNodesUp = null) {
  // THE WINNER UNDER THIS ROUND'S OWN BEACON (window-fixture playFor): the recorded tape misses there.
  await warmPlay(WINNER, w.randomness);
  const play = playFor(WINNER, w.randomness);
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
    joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
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
    ticks: Array.from({ length: WINNER.ticks }, (_, t) => play.words(t)), liquidations: [], loads: bedFrom(0) };
  const st = loaded(loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS))));
  for (let t = 0; t < WINNER.ticks; t++) step(st, ...play.words(t));
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

export const stateAt = (w, run) => w.signerNodes.map((d, i) => {
  if (!w.up.has(i)) return 'down';
  const nq = d.round.noQuorum(run.eid);
  return `${nq ? nq.outcome : 'none'}/${d.round.results(w.rid, run.eid).length}`;
});

// ---- THE OUTAGE-VOID ORDERS ON 5 OF 7 (ruled: two first marks is FORFEIT even
// after a real outage made signer nodes record ENTRY_VOID; on 5 of 7 one refusing signer node
// does not block a refund - five signatures form it). Measured, not read off 2 of 2.

/** Signer nodes 4-6 down; the first mark (60) and a mark past the start line to each of signer nodes 0-3: a real outage, they record ENTRY_VOID. */
export async function voidAtZeroToThree(w, run) {
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
export async function refundNow(w, run) {
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
export const NET = STAKE - entryFeeMsat(STAKE);

/** Each signer node's own record of the run: the result it signed (outcome/score), its finality, its no-quorum reason. */
export const recordsOf = (w, run) => ({
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
export async function lockAfterClose(w, run) {
  const up = [...w.up].sort((a, b) => a - b);
  // EVERY MARK OF THE PATH IS PLAY-TIME EVIDENCE: made before the result window's end block (RULED 2026-09-24: evidence
  // counts strictly before it). A path that ran past it would test a late pair, not the path it names.
  const endAtClose = (Number(roundEndMs(w.c)) + 605000);
  assert.ok(testNow() < endAtClose, `the path ran ${testNow() - endAtClose} ms past the result window's end block before its close`);
  await Promise.all(up.map((i) => say(w.signerNodes[i].port, `close ${toHex(w.rid)}`)));
  // PAST THE RESULT WINDOW ON THE CHAIN (RULED 2026-09-24): its end block - opened at the first block at or after the
  // round's contract end - before any §13C decision can be; then each signer node's next pass.
  const endMs = (Number(roundEndMs(w.c)) + 605000);
  skipTo(endMs + 100);
  for (let t = Date.now(); Date.now() - t < 20000
    && !up.every((i) => w.signerNodes[i].round.noQuorum(run.eid) || w.signerNodes[i].round.results(w.rid, run.eid).length); await wait(250));
  await wait(WINDOW + 1500);
  const q = `round=${toHex(w.rid)}&entry=${toHex(run.eid)}`;
  const doors = [];
  for (const i of up) doors.push((await fetch(`http://127.0.0.1:${w.signerNodes[i].port}/forfeit?${q}`)).status);
  return { signerNodes: stateAt(w, run), ...recordsOf(w, run), doors, kept: up.filter((i) => !!w.signerNodes[i].round.forfeit(run.eid)).length,
    lockHeld: w.locks.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}

// PATH 1 WITH SIGNER NODES 4-6 DOWN FROM BEFORE THE CLOSE THROUGH THE HOLD'S EXPIRY
// (M3.3-34, measured before any change). The reading to test: the proof formed at
// signer node 4; signer nodes 0-3 learned it by pulling and never gathered shares, so with 4-6
// down they hold 4 of the 5 shares a settle needs and the hold expires back.

/** What signer node `i` actually holds for the entry: shares it can open (its own + kept envelopes), the proof, its decision, its custody row. */
export const signerNodeHolds = (w, run, i) => {
  const d = w.signerNodes[i];
  const nq = d.round.noQuorum(run.eid);
  const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
  return { signerNode: i, shares: 1 + d.round.heldShares(run.eid).length, proof: d.round.provenTwoFirstMarks(w.rid, run.eid),
    decided: nq ? nq.outcome : null, signed: mine ? (() => { const p = decodePlayerResult(splitSignedResult(mine.bytes).body); return `${p.outcome}/${p.score}`; })() : null,
    voided: !!d.round.entryVoid(run.eid) };
};

// PATH 2 WITH SIGNER NODE 4 DOWN FROM ITS REFUSAL THROUGH THE EXPIRY (M3.3-34, the order
// TASKBOOK lists: signer nodes 0-3 ENTRY_VOID on a real outage; signer node 4 alone up, a LATE
// first mark (1500) to it - its forward lost; then every signer node back EXCEPT signer node 4,
// which goes down right after refusing the late mark and stays down).
export async function pathTwoSignerNodeFourDown(w, run) {
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

// A LOCK WITH RECEIPTS LOST BETWEEN SIGNER NODES THAT ARE UP (M3.3-34, the order TASKBOOK
// lists): five signer nodes each holding the on-time first mark and each short of five
// receipts would all record the Void and could sign a refund at once, before
// their close pulls the proof. Every signer node is up; their links to each other are
// cut while the player's first mark (60) and a mark past the line (1500) reach
// signer nodes 0-4 - each keeps its own receipt only, its six offers unanswered. Then the
// links heal and a DIFFERENT on-time first mark (30) reaches signer node 5.

/** Receipts each signer node holds for each of the entry's marks, in chain order. */
export const receiptsAt = (w, run) => w.signerNodes.map((d, i) => (w.up.has(i) ? d.round.markIds(w.rid, run.eid).map((id) => d.round.receiptCount(id)) : 'down'));

export async function voidAtZeroToFourCut(w, run, { second = true } = {}) {   // second: the different first mark to signer node 5
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
export async function outageCaughtUp(w, run) {
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
export const signedOutcomes = (w, run) => w.signerNodes.map((d, i) => {
  if (!w.up.has(i)) return 'down';
  return d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome)
    .filter((o, k, a) => a.indexOf(o) === k).join('+') || null;
});

// The names the tests read from these imports, handed on as they were.
export { TEST_FEDERATION_ID, ed25519, openStore, serve, resultFinality, feldmanGroup, tweakPoint, assumeAssigned, lockPort, contractFor, say, wait, opts, rand, b32, secretScalar, STAKE, joinAndPlay, WINNER, LOSER, RANDOMNESS, GENESIS_HASH, wordsAt, PLANTED_FIRST_MARK_DEADLINE, encodeRoundContract, roundId, encodeEntryContract, entryId, dealHandout, encodeHandout, handoutId, FIELD, scalarFrom32, encodeInputBatch, batchId, encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS, seedWordForEntry, entryFeeMsat, netStakeMsat, refundKeyOf, lockFieldsToJson, init, step, stateHash, toHex, sha256, SIGNED_RECEIPT_BYTES, decodePlayerResult, splitSignedResult };
