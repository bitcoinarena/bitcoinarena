// #1489 refute of #2980 (skeptic 2, s2-3): THE HONEST RESUME. An honest winner's final mark reaches seat A, and its
// connection to seat B drops at the end; the client reloads/resumes and resends that mark to B some seconds later (more
// than HELD_FINAL_ASK_MS, 5 s). Before #2980 seat B held its close for that mark and took it at the door. Now B gives the
// hold up after 5 s, signs the STOPPED transcript (FAILED at its last mark), and then refuses the resent mark at the
// door - while A holds the DELIVERED run. A winner who delivered loses the win to a 5 s reconnect.
// SAFE: the resent mark is taken and both seats sign the DELIVERED run, FINAL 2 of 2.
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { testNow, skipTo } from './test-clock.js';
import { presentDay, rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS } from './window-fixture.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { COUNTER, CONFIGS, COUNTER_GAME, COUNTER_GAME_ID } from './cores/counter.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const [LOW] = CONFIGS;

async function setup() {
  const mk = () => serve(openStore(':memory:'), { plugins: [NEXTBLOCK, COUNTER_GAME], port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk(); const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) { const there = [`http://127.0.0.1:${o.port}`]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there; }
  const c = presentDay({ ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    gameId: COUNTER_GAME_ID, stakeMsat: 0n, federationId: new Uint8Array(32), simCoreHash: fromHex(COUNTER.hash), configHash: LOW.hash,
    blockTicks: LOW.config.ticks, startDeadlineTicks: 90 }, testNow() + 3000);
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [a, b]) assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const ad = COUNTER.adapter;
  const st = ad.start(seedWordForEntry(entry, RANDOMNESS), LOW.config);
  const hashNow = () => fromHex(ad.stateHash(st));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const words = (from) => Array.from({ length: 60 }, (_, t) => wordsAt(from + t));
  for (let t = 0; t < 60; t++) ad.step(st, wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: words(0), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  for (let t = 60; t < 120; t++) ad.step(st, wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: words(60), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  const sb = (x) => signedBatchOf(x, (id) => ed25519.sign(id, session));
  return { a, b, c, rid, eid, played: ad.result(st), B1: sb(b1), M1: sign(m1), B2: sb(b2), M2: sign(m2),
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

const look = (w, d) => ({
  results: [...new Set(d.round.results(w.rid, w.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, w.eid).map((r) => toHex(r.nodePubkey))).size,
  finality: resultFinality(d.round, w.rid, w.eid).state });

test('#1489 s2-3: a winner whose final mark reaches seat B 7 s late (a resume) still gets DELIVERED signed 2 of 2', { timeout: 110000 }, async () => {
  const w = await setup();
  try {
    for (const d of [w.a, w.b]) { await say(d.port, w.B1); await say(d.port, w.M1); }
    await wait(300);
    for (const d of [w.a, w.b]) await say(d.port, w.B2);
    await say(w.a.port, w.M2);                         // the last mark reaches A; B's connection drops here
    await wait(300);
    for (const d of [w.a, w.b]) assert.equal(await say(d.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(7000);                                  // the client reloads and resumes
    let resent; try { resent = await say(w.b.port, w.M2); resent = typeof resent === 'string' ? resent.slice(0, 160) : `${resent.length} bytes`; } catch (e) { resent = String(e.message); }
    const ready = () => [w.a, w.b].every((d) => { const f = resultFinality(d.round, w.rid, w.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; });
    for (let t = Date.now(); Date.now() - t < 25000 && !ready(); await wait(200));
    const mid = { a: look(w, w.a), b: look(w, w.b) };
    console.log('  MID s2-3:', JSON.stringify({ played: w.played, resent, ...mid }));
    skipTo(Number(windowsOf(w.c).finalAfterMs) + 50);
    for (let t = Date.now(); Date.now() - t < 20000; await wait(200)) if ([w.a, w.b].every((d) => look(w, d).finality === 'FINAL')) break;
    const after = { a: look(w, w.a), b: look(w, w.b) };
    console.log('  FACTS s2-3:', JSON.stringify(after));
    assert.deepEqual(after.b.results, ['DELIVERED/' + w.played.score], `seat B did not sign the delivered run after the resumed mark: ${JSON.stringify(after.b)}`);
    assert.deepEqual([after.a.finality, after.b.finality], ['FINAL', 'FINAL'], `the run did not go FINAL 2 of 2: ${JSON.stringify(after)}`);
  } finally { await w.close(); }
});
