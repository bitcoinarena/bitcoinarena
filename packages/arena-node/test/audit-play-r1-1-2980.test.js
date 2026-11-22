// AUDIT play-r1-1: a player who sends its last mark to ONE seat only holds every other seat's close back for good.
//
// verify.js #holdBack: a seat whose close pulled a peer's receipt for a mark it has not got, and finds that mark at a
// peer (signed by the session key, chained onto a mark it holds), keeps a held_final_ask and signs NOTHING until the
// round's settlement is combined. Nothing feeds the held mark but the player. A modified client (role a) that sends its
// final mark to seat A only and stops: A signs the run (FAILED at its last carried mark), B holds back - the run never
// reaches its threshold, never FINAL, and the round's settlement ("nothing is claimed while a run is not final") never
// combines, so the hold-back never ends either. SAFE: B signs the stopped transcript A signed, and the run goes FINAL 2 of 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

async function seats() {
  const mk = (db) => serve(db, { plugins: HOSTED, port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk(openStore(':memory:'));
  const b = await mk(openStore(':memory:'));
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
  }
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    stakeMsat: 0n, federationId: new Uint8Array(32) };
  const c = presentDay(base, testNow() + 5000);
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { a, b, c, rid, async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

async function player(w) {
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
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
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS };
  for (let t = 60; t < 120; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1) };
  const sb = (b) => signedBatchOf(b, (id) => ed25519.sign(id, session));
  return { eid, b1: sb(b1), m1: sign(m1), b2: sb(b2), m2: sign(m2) };
}

const look = (w, d, eid) => ({
  results: [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, eid).map((r) => toHex(r.nodePubkey))).size,
  finality: resultFinality(d.round, w.rid, eid).state });

test('a last mark sent to one seat only does not keep the other seat from signing the run, and the run goes final', async () => {
  const w = await seats();
  try {
    const P = await player(w);
    // the run starts at both seats, both receipt the first mark and hold every input
    for (const d of [w.a, w.b]) { await say(d.port, P.b1); await say(d.port, P.m1); }
    await wait(300);
    for (const d of [w.a, w.b]) await say(d.port, P.b2);
    // THE ATTACK: the mark at tick 120 goes to seat A only, and the client sends nothing more
    await say(w.a.port, P.m2);
    await wait(300);
    for (const d of [w.a, w.b]) assert.equal(await say(d.port, `close ${toHex(w.rid)}`), 'closed');
    // wait for both seats to sign, then run the windows forward as close-retry.test.js does
    const signed = () => [w.a, w.b].every((d) => look(w, d, P.eid).signers >= 1);
    for (let t = Date.now(); Date.now() - t < 20000; await wait(200)) if (signed()) break;
    skipTo(Number(roundEndMs(w.c)) + 605000 + 100);
    for (let t = Date.now(); Date.now() - t < 15000; await wait(200))
      if ([w.a, w.b].every((d) => look(w, d, P.eid).finality === 'FINAL')) break;
    const after = { a: look(w, w.a, P.eid), b: look(w, w.b, P.eid), heldAskAtB: !!w.b.round.heldFinalAsk(P.eid) };
    console.log('  FACTS audit-play-r1-1:', JSON.stringify(after));
    assert.equal(after.b.signers >= 1, true, `seat B never signed the run: it holds back its close for a mark only seat A got (held_final_ask ${after.heldAskAtB})`);
    assert.equal(after.a.finality, 'FINAL', `the run is not FINAL at A: ${JSON.stringify(after.a)}`);
    assert.equal(after.b.finality, 'FINAL', `the run is not FINAL at B: ${JSON.stringify(after.b)}`);
  } finally { await w.close(); }
});

