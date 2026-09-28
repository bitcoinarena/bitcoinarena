// THE FIRST-MARK FIXTURE: two in-process signer nodes of a lock round and the helpers first-mark.test.js and
// first-mark-late.test.js share (split 2026-09-24 so each file stays inside the suite's 180 s: every round now waits
// for its result window's end block on the chain). See first-mark.test.js for the rules they drive.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait, presentDay } from './window-fixture.js';
import { CLOCK } from './block-clock.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { START_DEADLINE_TICKS } from '../../protocol/src/constants.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

export const curve = { ...feldmanGroup, tweakPoint };
export const END = WINNER.ticks;                      // 1320: the run delivers here

export async function signerNodes({ endIn = null } = {}) {
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25: a paying round opens only on a signer node that
  // reads the chain, and its beacon is that chain's). Both are running daemons: the claim key is their own live DKG.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const mk = (db, p = 0) => serve(db, { port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 },
    chainFor: slot.chainFor, randomnessFor: slot.randomnessFor });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  let a = await mk(dbA);
  let b = await mk(dbB);
  const aPort = a.port;
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  // THIS ROUND NAMES NO START DEADLINE: it gets the page's own window, 900 -
  // not the 1400 the fixture's settling rounds name past their planted marks.
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  // `endIn`: THE ROUND IN THE PRESENT, its contract end this many ms from now (§13C's result window opens at it).
  const drafted = endIn === null ? base : presentDay(base, Date.now() + endIn);
  // ONLY THE FIELD THE CHAIN DICTATES (RULED 2026-09-25): the census root its bonds derive to; the round's times stand.
  const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
    { endpoints: [a, b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  // THE ROUND'S OWN BEACON: the players seed their marks from it, as the signer nodes replay them.
  const beacon = slot.randomnessFor({ contract: c });
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    get a() { return a; }, get b() { return b; }, c, rid, port, randomness: beacon && beacon.hash, claimPk: a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async downA() { await a.close(); },
    async upA() { a = await mk(dbA, aPort); wire(); },
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { try { await a.close(); } catch { /* already down */ } try { await b.close(); } catch { /* already down */ } },
  };
}

/** Joined and locked at both signer nodes; the run's messages, with its first mark at `firstAt`. */
export async function joinAndBuild(w, { firstAt = 60 } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  // AND IT BRINGS ITS FEE LOCK (2026-09-21). `lock-fixture`'s federation is legal now - no base fee, as §22A
  // requires - so this round's gate mints fee locks, and pick (a)'s door refuses an entry that names none.
  // That is the production shape: a staked entry arrives with the 2% already locked to H(F).
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: WINNER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk: w.claimPk, refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(feeOutpoint, feeFields);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
    assert.equal((await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) })).status, 201);
  }
  const st = init(seedWordForEntry(entry, w.randomness || RANDOMNESS));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => wordsAt(from + t)), liquidations: [] });
  const markOf = (tick, stateHashAt, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: stateHashAt,
    inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  let messages;
  let firstId;
  if (firstAt < END) {
    const b1 = batchOf(0, firstAt, GENESIS_HASH);
    const m1 = markOf(firstAt, hashAt(firstAt, 0), b1, NO_PREVIOUS);
    const b2 = batchOf(firstAt, END, batchId(b1));
    const m2 = markOf(END, hashAt(END, firstAt), b2, checkpointId(m1));
    messages = [encodeInputBatch(b1), sign(m1), encodeInputBatch(b2), sign(m2)];
    firstId = checkpointId(m1);
  } else {
    const b1 = batchOf(0, END, GENESIS_HASH);
    const m1 = markOf(END, hashAt(END, 0), b1, NO_PREVIOUS);
    messages = [encodeInputBatch(b1), sign(m1)];
    firstId = checkpointId(m1);
  }
  // AND A LATE FIRST MARK FOR THE SAME ENTRY, under the same session key: its
  // first batch 0..1319 and a first mark at 1320 - the other half of a player
  // who sent an on-time first mark to one signer node and a late one to another.
  const lateSt = init(seedWordForEntry(entry, w.randomness || RANDOMNESS));
  for (let t = 0; t < END; t++) step(lateSt, ...wordsAt(t));
  const lb = batchOf(0, END, GENESIS_HASH);
  const lm = markOf(END, Uint8Array.from(stateHash(lateSt).match(/../g).map((x) => parseInt(x, 16))), lb, NO_PREVIOUS);
  const late = [encodeInputBatch(lb), sign(lm)];
  // AND A SECOND ON-TIME FIRST MARK (tick 30, from nothing): the other half of a
  // player who sent one on-time first mark to one signer node and a different one to another.
  const otherSt = init(seedWordForEntry(entry, w.randomness || RANDOMNESS));
  for (let t = 0; t < 30; t++) step(otherSt, ...wordsAt(t));
  const ob = batchOf(0, 30, GENESIS_HASH);
  const om = markOf(30, Uint8Array.from(stateHash(otherSt).match(/../g).map((x) => parseInt(x, 16))), ob, NO_PREVIOUS);
  const other = [encodeInputBatch(ob), sign(om)];
  // AND THE SAME PLAYER MARKING AGAIN AFTER A LATE FIRST MARK WAS REFUSED (2026-09-21). Measured on the
  // Daily: the first mark went out at 5940 against a window ending at 900, was refused as a late start and
  // never carried, so the client's head stayed ZERO and it marked again every second - 80 times. This is
  // one of those: past the line like the first one, a different tick, and its own inputs from nothing.
  const againSt = init(seedWordForEntry(entry, w.randomness || RANDOMNESS));
  const AGAIN_AT = 960;
  for (let t = 0; t < AGAIN_AT; t++) step(againSt, ...wordsAt(t));
  const gb = batchOf(0, AGAIN_AT, GENESIS_HASH);
  const gm = markOf(AGAIN_AT, Uint8Array.from(stateHash(againSt).match(/../g).map((x) => parseInt(x, 16))), gb, NO_PREVIOUS);
  const again = [encodeInputBatch(gb), sign(gm)];
  return { entry, eid, outpoint, messages, firstId, late, other, again, againAt: AGAIN_AT };
}

export const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');
export const holdsFirst = (d, run) => d.round.holdsMark(run.firstId);
export async function outcomeAt(d, w, run) {
  const v = d.round.startForfeit(run.eid);
  const results = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome);
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  return { lateStart: v ? `FORFEIT at ${v.markTick} > ${v.lastTick}` : null, results: [...new Set(results)], finality: resultFinality(d.round, w.rid, run.eid).state,
    forfeit: f.status };
}
export async function closeAndSettle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
}
// PAST THE RESULT WINDOW ON THE CHAIN (RULED 2026-09-24): its end block - opened at the first block at or after the
// round's contract end - and then each node's next pass that decides; not W past the close.
export async function pastResultWindow(w, decided) {
  const endMs = CLOCK.endAt(Math.ceil(Number(roundEndMs(w.c)) / 1000) * 1000, WINDOW_MS);
  for (const stop = Date.now() + 30000; Date.now() < stop && Date.now() < endMs; await wait(100));
  for (const stop = Date.now() + 30000; Date.now() < stop && !decided(); await wait(100));
}
export const decidedBoth = (w, run) => () => [w.a, w.b].every((d) => d.round.noQuorum(run.eid));
export const untilForwarded = async (d, run) => { for (let t = Date.now(); Date.now() - t < 5000; await wait(100)) if (holdsFirst(d, run) || d.round.startForfeit(run.eid)) return true; return false; };


// LATE START AT THE CLOSE (M3.3-34, ruled 2026-09-12). A joined player whose
// first mark came after join tick + the start deadline has forfeited, whenever
// the close comes: FORFEIT, score 0, over the empty receipted transcript,
// signed by both signer nodes, FINAL 2 of 2 - not VOID, not ENTRY_VOID, not FAILED,
// nothing refunded, the lock held. The same FORFEIT 0 as no mark at all,
// whichever signer node recorded the late mark. MEASURED BEFORE: FORFEIT recorded at
// the door, no signed result at either signer node, finality null.
export async function signedAt(d, w, run) {
  const rs = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  return { lateStart: !!d.round.startForfeit(run.eid), results: [...new Set(rs.map((p) => `${p.outcome}/${p.score}`))],
    transcripts: [...new Set(rs.map((p) => toHex(p.transcriptHash).slice(0, 16)))],
    signers: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(r.nodePubkey))).size,
    finality: resultFinality(d.round, w.rid, run.eid).state, entryVoid: !!d.round.entryVoid(run.eid), forfeit: f.status };
}
export const transcriptsAcross = (x, y) => new Set([...x.transcripts, ...y.transcripts]).size;
export const lockHeldOf = (w, run) => w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`);
export const closingOf = async (d, w, run) => ((await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json())
  .find((s) => s.entry === toHex(run.eid)) || null);
export const finalAtBoth = async (w, run, ms = 20000) => {
  for (let t = Date.now(); Date.now() - t < ms; await wait(250))
    if ([w.a, w.b].every((d) => resultFinality(d.round, w.rid, run.eid).state === 'FINAL')) return true;
  return false;
};
export const SIGNED_FORFEIT_0 = { results: ['FORFEIT/0'], signers: 2, finality: 'FINAL', entryVoid: false, forfeit: 409 };
export const brief = (s) => ({ results: s.results, signers: s.signers, finality: s.finality, entryVoid: s.entryVoid, forfeit: s.forfeit });

export { TEST_FEDERATION_ID, assert, ed25519, openStore, serve, feldmanGroup, tweakPoint, resultFinality, assumeAssigned, lockPort, b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait, presentDay, CLOCK, roundEndMs, encodeRoundContract, roundId, encodeEntryContract, entryId, START_DEADLINE_TICKS, dealHandout, encodeHandout, handoutId, FIELD, scalarFrom32, encodeInputBatch, batchId, encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS, decodePlayerResult, splitSignedResult, init, step, stateHash, seedWordForEntry, netStakeMsat, entryFeeMsat, refundKeyOf, lockFieldsToJson, toHex, sha256 };
