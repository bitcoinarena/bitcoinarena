// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE WHOSE PEER IS DOWN AT THE CLOSE HOLDS AND TRIES AGAIN (M3.3-34, the Daily's close).
//
// Signer node A closes a free 2-of-2 round while signer node B is down: A cannot pull B's
// receipts, so it can neither form the receipted transcript of a played run
// nor rule out a first mark B holds. It signs nothing - HOLDING at /closing,
// the close tried again on the finality watch's cadence - and records no
// ENTRY_VOID and no VOID: a disconnect is not an escape. When B is back and
// closes too, both signer nodes sign ONE transcript per run and it goes FINAL 2 of 2:
//   W  joined, sent nothing                FORFEIT, score 0
//   P  marks at ticks 60 and 120, stops    FAILED at its last receipted mark
// And it keeps asking past the objection window, and across a restart of A.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): the close ran once - a signer node that could
// not reach its peer signed neither run and nothing asked again; then, with
// the first retry build, the watch gave up at the window's end and a restart
// forgot the hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

async function signerNodes({ finality = {}, endIn = null } = {}) {
  const mk = (db, port = 0, more = {}) => serve(db, { plugins: HOSTED, port, ...opts, finality: { everyMs: 100, ...finality }, ...more });
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
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    stakeMsat: 0n, federationId: new Uint8Array(32) };
  // `endIn`: THE ROUND IN THE PRESENT, its contract end this many ms from now (§13C's result window opens at it, and the
  // objection window: 600 s of wall time, WINDOW-10-SPEC). Left out, the round sits in 1970 and both windows closed long ago.
  const c = endIn === null ? base : presentDay(base, testNow() + endIn);
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { get a() { return a; }, get b() { return b; }, c, rid,
    async downB() { await b.close(); }, async upB(more) { b = await mk(dbB, bPort, more); wire(); },
    async restartA(more) { await a.close(); a = await mk(dbA, aPort, more); wire(); },
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

async function signerNode(w, playerPubkey) {
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: w.rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [w.a, w.b])
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashNow = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  for (let t = 0; t < 60; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  // AND A SECOND MARK, at tick 120: a signer node that forwarded the first mark holds its
  // peer's receipt of that one only, so the two signer nodes' receipted transcripts
  // differ unless the one that could not reach its peer waits.
  for (let t = 60; t < 120; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  return { eid, start: [encodeInputBatch(b1), sign(m1)], more: [encodeInputBatch(b2), sign(m2)] };
}

const look = (w, d, run) => ({
  results: [...new Set(d.round.results(w.rid, run.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(r.nodePubkey))).size,
  transcripts: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).transcriptHash))).size,
  finality: resultFinality(d.round, w.rid, run.eid).state, entryVoid: !!d.round.entryVoid(run.eid) });
const closingAt = async (w, d, run) => (await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json())
  .find((s) => s.entry === toHex(run.eid)) || null;
const brief = (c) => c && { state: c.state, attempts: c.attempts, sinceMs: c.sinceMs, lastWhy: c.lastWhy && c.lastWhy.slice(0, 50) };
// WAITED ON, NOT SLEPT ON: in the full suite a close can take longer than a
// fixed sleep, and a count read too early reads nothing.
const until = async (ms, ok) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) { const v = await ok(); if (v) return v; } return null; };

async function playedAndJoined(w) {
  const P = await signerNode(w, WINNER.key);
  const W = await signerNode(w, schnorr.getPublicKey(rand(32)));
  for (const d of [w.a, w.b]) for (const m of P.start) await say(d.port, m);
  await wait(300);
  for (const d of [w.a, w.b]) for (const m of P.more) await say(d.port, m);
  await wait(300);
  return { P, W };
}
async function backAndFinal(w, runs, more) {
  await w.upB(more);
  assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
  // BOTH SIGN, THEN THE WINDOW RUNS ITS 600 s (WINDOW-10-SPEC) - skipped on the fixtures' clock - AND BOTH SIGN FINAL.
  const states = () => [w.a, w.b].flatMap((d) => runs.map((r) => resultFinality(d.round, w.rid, r.eid).state));
  // AND PUBLISHED, as a live seat's are seconds after its result (§13A,: a posting counts only if its seat held it
  // before final_after) - then the skip
  const ready = () => [w.a, w.b].every((d) => runs.every((r) => { const f = resultFinality(d.round, w.rid, r.eid); return f.state === 'FINAL' || (f.state === 'PROVISIONALLY_FINAL' && f.published === true); }));
  for (let t = Date.now(); Date.now() - t < 25000; await wait(200))
    if (ready()) break;
  skipTo(Number(roundEndMs(w.c)) + 605000 + 100);
  for (let t = Date.now(); Date.now() - t < 25000; await wait(200))
    if (states().every((x) => x === 'FINAL')) break;
}
function assertOneFinal(after) {
  for (const s of ['a', 'b']) {
    assert.deepEqual(after.W[s], { results: ['FORFEIT/0'], signers: 2, transcripts: 1, finality: 'FINAL', entryVoid: false });
    assert.equal(after.P[s].results.length, 1);
    assert.match(after.P[s].results[0], /^FAILED\//);
    assert.deepEqual({ ...after.P[s], results: undefined }, { results: undefined, signers: 2, transcripts: 1, finality: 'FINAL', entryVoid: false });
  }
}

test('a signer node whose peer is down at the close holds - no result, no Void - tries again, and both runs go final 2 of 2 when the peer is back', async () => {
  const w = await signerNodes({ endIn: 5000 });
  try {
    const { P, W } = await playedAndJoined(w);
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    const whileDown = { P: { a: look(w, w.a, P), closing: await closingAt(w, w.a, P) }, W: { a: look(w, w.a, W), closing: await closingAt(w, w.a, W) } };
    await backAndFinal(w, [P, W]);
    const after = { P: { a: look(w, w.a, P), b: look(w, w.b, P), closing: await closingAt(w, w.a, P) },
      W: { a: look(w, w.a, W), b: look(w, w.b, W), closing: await closingAt(w, w.a, W) } };
    console.log('  FACTS (peer down at close):', JSON.stringify({
      whileDown: { P: { ...whileDown.P, closing: brief(whileDown.P.closing) }, W: { ...whileDown.W, closing: brief(whileDown.W.closing) } },
      after: { P: { ...after.P, closing: brief(after.P.closing) }, W: { ...after.W, closing: brief(after.W.closing) } } }));

    // WHILE B IS DOWN: both runs are held at A - nothing signed, no Void, tried again.
    for (const run of ['W', 'P']) {
      assert.deepEqual(whileDown[run].a, { results: [], signers: 0, transcripts: 0, finality: null, entryVoid: false }, run);
      assert.equal(whileDown[run].closing.state, 'HOLDING', run);
      assert.ok(whileDown[run].closing.attempts >= 3, `${run} tried ${whileDown[run].closing.attempts} times in 1.5 s at a 100 ms cadence`);
      assert.match(whileDown[run].closing.lastWhy, /waiting on 1 signer node/, run);
    }
    // AND AFTER: both runs final 2 of 2 at both signer nodes, each over ONE transcript, as ruled.
    assertOneFinal(after);
    assert.equal(after.W.closing.state, 'SIGNED');
    assert.equal(after.P.closing.state, 'SIGNED');
  } finally { await w.close(); }
});

// THE OWNER 2026-09-15 07:49: the result window is the objection window (the contract's
// objection_window_ms, WINDOW_MS here), and a signer node that cannot retrieve the transcript in it
// treats the entry as VOID. Until then (M3.3-34) this signer node kept asking past the window and both
// runs went final 2 of 2 when its peer came back - measured this morning, the test this replaces.
test('past the result window a signer node that cannot retrieve the transcript decides VOID (§13C), and no run it voided is FINAL anywhere after its peer is back', async () => {
  // The watch's window is 800 ms here, its back-off capped at 400 ms.
  const w = await signerNodes({ finality: { windowMs: 800, maxEveryMs: 400 }, endIn: 4000 });
  try {
    const { P, W } = await playedAndJoined(w);
    await w.downB();
    const closedAt = Date.now();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(700);
    const inWindowAt = await until(10000, () => closingAt(w, w.a, W));
    const inWindow = { state: inWindowAt.state, attempts: inWindowAt.attempts };
    // PAST THE RESULT WINDOW (WINDOW-10-SPEC): the round's end + 600 s, decided from + 605 s on each seat's clock - not W
    // past this node's close, and no block. Skipped to on the fixtures' clock.
    const endMs = Number(roundEndMs(w.c)) + 605000;
    const insideAt = testNow();
    skipTo(endMs + 100);
    await until(15000, () => ['W', 'P'].every((k) => resultFinality(w.a.round, w.rid, { W, P }[k].eid).state === 'VOID'));
    await wait(500);
    const pastWindow = { W: brief(await closingAt(w, w.a, W)), P: brief(await closingAt(w, w.a, P)),
      atA: { W: look(w, w.a, W), P: look(w, w.a, P) } };
    // B BACK, and closed: it signs what it replays (1 of 2), and - the result window's end block already in its chain,
    // with A saying it decided the entry by §13C, so no quorum can form - it decides the same. Measured before that
    // follow-up: B signed 1 of 2 and its watch asked with no end. Its own close + W no longer matters (RULED 2026-09-24).
    await w.upB();
    const bClosedAt = testNow();
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
    await until(15000, () => ['W', 'P'].every((k) => resultFinality(w.b.round, w.rid, { W, P }[k].eid).state === 'VOID'));
    const bDecidedAfterMs = testNow() - bClosedAt;
    const after = { P: { a: look(w, w.a, P), b: look(w, w.b, P) }, W: { a: look(w, w.a, W), b: look(w, w.b, W) } };
    console.log('  FACTS (past the window):', JSON.stringify({ inWindow, pastWindow, after, bDecidedAfterMs, endBlockAfterCloseA: endMs - closedAt }));
    assert.ok(insideAt < endMs, 'the in-window read was not inside the result window');
    assert.ok(bClosedAt >= endMs, 'B closed before the window\'s end: B deciding would say nothing about the window');
    assert.equal(inWindow.state, 'HOLDING', 'inside the window the signer node waits, as before');
    assert.ok(pastWindow.W.attempts > inWindow.attempts, `no retry after the window: ${inWindow.attempts} then ${pastWindow.W.attempts}`);
    for (const run of ['W', 'P']) {
      assert.equal(pastWindow[run].state, 'VOID', run);
      assert.match(pastWindow[run].lastWhy, /no quorum at 0 of 2/, run);
      assert.deepEqual(pastWindow.atA[run], { results: [], signers: 0, transcripts: 0, finality: 'VOID', entryVoid: false }, run);
      // AND IT STAYS SO: A signs nothing for a run it voided, and nothing it voided goes final at B.
      assert.equal(after[run].a.finality, 'VOID', run);
      assert.deepEqual(after[run].a.results, [], run);
      assert.notEqual(after[run].b.finality, 'FINAL', `${run}: a run A voided went final at B`);
      assert.equal(after[run].b.finality, 'VOID', `${run}: B, back, did not decide it after its own window`);
      assert.equal(after[run].b.signers, 1, `${run}: B's own signature is history, not withdrawn`);
    }
  } finally { await w.close(); }
});

test('a signer node restarted while holding picks the hold up from its store, and signs the one transcript when its peer is back', async () => {
  const w = await signerNodes({ endIn: 5000 });
  try {
    const { P, W } = await playedAndJoined(w);
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(800);
    const before = brief(await until(10000, () => closingAt(w, w.a, W)));
    // BOTH SIGNER NODES COME BACK WITH A CHAIN READER THAT HAS READ NOTHING YET, as the
    // Daily's do: its answers live in memory, so only the signer node's store still
    // names the beacon a retry replays from.
    const readNothing = { randomnessFor: () => undefined };
    await w.restartA(readNothing);
    await wait(800);
    await until(10000, async () => { const c = await closingAt(w, w.a, W); return c && c.attempts > before.attempts; });
    const resumed = { W: brief(await closingAt(w, w.a, W)), P: brief(await closingAt(w, w.a, P)),
      atA: { W: look(w, w.a, W), P: look(w, w.a, P) } };
    await backAndFinal(w, [P, W], readNothing);
    const after = { P: { a: look(w, w.a, P), b: look(w, w.b, P) }, W: { a: look(w, w.a, W), b: look(w, w.b, W) } };
    console.log('  FACTS (restart while holding):', JSON.stringify({ before, resumed, after }));
    assert.equal(before.state, 'HOLDING');
    assert.equal(resumed.W.state, 'HOLDING');
    assert.equal(resumed.W.sinceMs, before.sinceMs, 'the hold began again instead of being read back');
    assert.ok(resumed.W.attempts > before.attempts, `no retry after the restart: ${before.attempts} then ${resumed.W.attempts}`);
    assert.equal(resumed.P.state, 'HOLDING');
    assert.deepEqual(resumed.atA.W, { results: [], signers: 0, transcripts: 0, finality: null, entryVoid: false });
    assertOneFinal(after);
  } finally { await w.close(); }
});
