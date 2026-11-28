// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RUN WHOSE MARKS NAME GENESIS IS DECIDED AT THE CLOSE (kanban #3762, RULED 2026-11-26 option (a), protocol 2026.0.34; main: since #3567).
//
// Since #3567 the close replays a run only through the inputs its last carried mark commits to. A mark naming GENESIS commits to none,
// so the replay had no ticks, no seat signed, nothing else decided it (no in-time result, every seat up), and the round never settled
// (measured on #3762: both seats HOLDING "that transcript carries no ticks", 3 days later too). From protocol 34 such a run is what its
// marks commit to - a run that never started: FORFEIT, score 0 (§15, like a joined entry that sent nothing). Below 34 nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS, presentDay } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { SUPPORTED_PROTOCOL_VERSIONS, GENESIS_RUN_VERSION } from '../../arena-protocol/src/constants.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

async function genesisRun(version) {
  const mk = (db) => serve(db, { plugins: HOSTED, port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk(openStore(':memory:')), b = await mk(openStore(':memory:'));
  for (const [d, o] of [[a, b], [b, a]]) { const there = [`http://127.0.0.1:${o.port}`]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there; }
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    stakeMsat: 0n, federationId: new Uint8Array(32) };
  const c = { ...presentDay(base, testNow() + 5000), ...(version ? { protocolVersion: version } : {}) };
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
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
  // THE OLD CLIENT: batches sent, but every mark names GENESIS as its input head (markNow with no chain, before #3758)
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashNow = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  for (let t = 0; t < 60; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  for (let t = 60; t < 120; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: GENESIS_HASH, previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  for (const m of [signedBatchOf(b1, (id) => ed25519.sign(id, session)), sign(m1)]) for (const d of [a, b]) await say(d.port, m);
  await wait(300);
  for (const m of [signedBatchOf(b2, (id) => ed25519.sign(id, session)), sign(m2)]) for (const d of [a, b]) await say(d.port, m);
  await wait(300);
  for (const d of [a, b]) assert.equal(await say(d.port, `close ${toHex(rid)}`), 'closed');
  const results = (d) => [...new Set(d.round.results(rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))];
  const transcripts = () => new Set([a, b].flatMap((d) => d.round.results(rid, eid).map((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).transcriptHash)))).size;
  for (let t = Date.now(); Date.now() - t < 8000 && !(results(a).length && results(b).length); await wait(100));
  const closing = async (d) => ((await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(rid)}`)).json()).find((s) => s.entry === toHex(eid)) || {});
  const out = { a: results(a), b: results(b), transcripts: transcripts(), closingA: (await closing(a)).state, whyA: String((await closing(a)).lastWhy || '').slice(0, 60) };
  await a.close(); await b.close();
  return out;
}

test('#3762 below protocol 34 a run whose marks name GENESIS stays as today: held, unsigned', async () => {
  const r = await genesisRun(null);
  console.log('  FACTS (old version):', JSON.stringify(r));
  assert.deepEqual([r.a, r.b], [[], []]);
  assert.equal(r.closingA, 'HOLDING');
});

test('#3762 from protocol 34 a run whose marks name GENESIS is FORFEIT 0 at every seat, over one transcript', { skip: !SUPPORTED_PROTOCOL_VERSIONS.includes(GENESIS_RUN_VERSION) && 'protocol 34 is not on this build' }, async () => {
  const r = await genesisRun(GENESIS_RUN_VERSION);
  console.log('  FACTS (v34):', JSON.stringify(r));
  assert.deepEqual([r.a, r.b], [['FORFEIT/0'], ['FORFEIT/0']]);
  assert.equal(r.transcripts, 1);
  assert.ok(!r.closingA || r.closingA === 'SIGNED', r.closingA);
});
