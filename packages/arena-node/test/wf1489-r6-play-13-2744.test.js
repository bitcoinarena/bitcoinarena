// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r6 (play) 13: GET /share STARTS A FIRST-MARK PROOF PULL FROM EVERY PEER FOR EVERY STRANGER'S REQUEST
// (bypass of #1632's one-pull-in-flight on POST /proof-pull).
// #1632 made POST /proof-pull join the pull already running for an entry, so a stranger's repeated asks do not each start
// a round of peer reads (GET /late-first-mark, /entry-void, /equivocation at every peer) and signature checks. GET /share
// runs the same verifier.pullFirstMarkProof directly, with no in-flight share and no caller check: whenever
// stakeSecrets.answer refuses - always, for a stranger naming no signer node - and either `proof=1` is in the query or the
// entry has no result yet (every entry of every open round), each request is a whole pull: one to three timed fetches per
// peer, every one of them a request to another seat. Round and entry ids are public; 40 parallel requests are 40 pulls,
// 40 x (peers) requests sent on by the seat, an amplifier against the committee.
// Safe: GET /share joins the pull in flight for that entry, as POST /proof-pull does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, opts, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';

test('#1489-r6-play-13: 40 strangers\' GET /share of one entry start 40 proof pulls at every peer (POST /proof-pull starts one)', { timeout: 120000 }, async () => {
  const mk = () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  const a = await mk(); const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) { const there = [`http://127.0.0.1:${o.port}`]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there; }
  // A COUNTING PEER: what A sends on to the committee, each answered slowly (as a loaded seat answers)
  const hits = { equivocation: 0, all: 0 };
  const peer = createServer((req, res) => {
    hits.all++; if (req.url.startsWith('/equivocation')) hits.equivocation++;
    setTimeout(() => { res.writeHead(404); res.end('none'); }, 400);
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  try {
    const c = presentDay({ ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)), stakeMsat: 0n, federationId: new Uint8Array(32) }, testNow() + 3600000);
    const rid = roundId(c);
    for (const d of [a, b]) {
      assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      assumeAssigned(d.round, rid, c.nodes);
    }
    skipTo(Number(c.committeeTimeMs) + 20);
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
      stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32) };
    const eid = entryId(entry);
    for (const d of [a, b]) { const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) }); assert.equal(r.status, 201, await r.text()); }
    a.verifier.peers = [`http://127.0.0.1:${peer.address().port}`];
    const q = `round=${toHex(rid)}&entry=${toHex(eid)}`;
    // CONTROL: POST /proof-pull, 40 at once - one pull in flight (#1632)
    await Promise.all(Array.from({ length: 40 }, () => fetch(`http://127.0.0.1:${a.port}/proof-pull?${q}`, { method: 'POST' }).then((r) => r.text())));
    const control = hits.equivocation;
    // THE STRANGER: GET /share, 40 at once, no signer node named
    hits.equivocation = 0; hits.all = 0;
    const said = await Promise.all(Array.from({ length: 40 }, () => fetch(`http://127.0.0.1:${a.port}/share?${q}&proof=1`).then((r) => r.status)));
    console.log(`  FACTS: POST /proof-pull x40 -> ${control} pull(s) at the peer; GET /share x40 (answered ${[...new Set(said)]}) -> ${hits.equivocation} /equivocation pulls, ${hits.all} requests sent on to the peer`);
    assert.ok(control <= 2, `control: POST /proof-pull started ${control} pulls`);
    assert.ok(hits.equivocation <= 2, `40 strangers' GET /share made A pull the peer's proof ${hits.equivocation} times (${hits.all} requests sent on)`);
  } finally { await a.close(); await b.close(); peer.close(); }
});
