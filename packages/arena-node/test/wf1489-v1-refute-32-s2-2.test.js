// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, #1802 (the fix of v1-refute-32-s2-1, the other side).
// A player with two entries: a peer's result for one of them still counts when the transcript it names is that entry's - one this
// node holds (its own result's), or bytes a peer serves that hash to that name and carry the entry's id - and is refused when the
// transcript it names carries the player's OTHER entry. A dissent about the entry itself is not lost to the #1802 tie.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';

test('#1802: a two-entry player\'s peer results count when their transcript is the entry\'s, and only then', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { Verifier } = await import('../src/verify.js');
  const { Client } = await import('../../arena-client/src/client.js');
  const { HOSTED } = await import('./plugins/hosted.js');
  const { NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../../nextblock/plugin/nextblock.js');
  const { TEST_FEDERATION_ID } = await import('../../arena-protocol/src/test-federation.js');
  const { BLOCK_TICKS } = await import('../../nextblock/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../arena-protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../arena-protocol/src/donation.js');
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { encodeTranscript } = await import('../../arena-protocol/src/transcript.js');
  const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
  const { SIGNED_CHECKPOINT_BYTES } = await import('../../arena-protocol/src/checkpoint.js');
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../../nextblock/dist/blwp-core.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  // two OTHER honest committee members (their secrets only sign their true results)
  const kA = schnorr.utils.randomSecretKey(), kB = schnorr.utils.randomSecretKey();
  const pA = schnorr.getPublicKey(kA), pB = schnorr.getPublicKey(kB);
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  let peerBody = new Uint8Array(0), peerCanonical = new Uint8Array(0);
  const peer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(req.url.startsWith('/canonical') ? peerCanonical : peerBody)); });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  try {
    const s1 = ed25519.utils.randomSecretKey(), s2 = ed25519.utils.randomSecretKey();
    const c1 = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, s1), verify: () => true });
    const c2 = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, s2), verify: () => true });
    const rid = await c1.openRound({
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey, pA, pB],
    });
    const entry = (session, ws) => ({
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(ws), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    });
    // THE SAME PLAYER, TWO ENTRIES (a reload's second entry, a new session key - #1479 refuses only the same session key twice)
    const e1 = await c1.join(entry(s1, 0x5e));
    const e2 = await c2.join(entry(s2, 0x5f));
    assert.notEqual(toHex(e1), toHex(e2));
    if (!node.round.signerNodes(rid).length) node.round.recordSignerNodes(rid, [node.round.pubkey, pA, pB]);
    const signed = (res, secret) => joinSignedResult(encodePlayerResult(res), schnorr.sign(resultId(res), secret));
    // A TRANSCRIPT OF E2 (one mark this node does not hold) and the same bytes about E1
    const mark = new Uint8Array(SIGNED_CHECKPOINT_BYTES).fill(0x33);
    const tE2 = encodeTranscript({ roundId: rid, entryId: e2, batches: [], marks: [mark] });
    const tE1 = encodeTranscript({ roundId: rid, entryId: e1, batches: [], marks: [mark] });
    const own = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 42, transcriptHash: b32(3), simCoreHash: TRUCK_CORE_HASH, nodePubkey: node.round.pubkey };
    node.round.putResult(Buffer.from(rid), Buffer.from(e2), Buffer.from(node.round.pubkey), Buffer.from(resultId(own)), Buffer.from(signed(own, node.round.identity.secret)));
    // A agrees with this node (transcript 3, its own result's); B dissents on E2's transcript served by the peer
    const rA = signed({ ...own, nodePubkey: pA }, kA);
    const rB = signed({ ...own, score: 7, transcriptHash: transcriptBytesHash(tE2), nodePubkey: pB }, kB);
    const cat = (xs) => { const o = new Uint8Array(xs.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of xs) { o.set(b, at); at += b.length; } return o; };
    peerBody = cat([rA, rB]); peerCanonical = tE2;
    const v = new Verifier(node.round, { peers: [`http://127.0.0.1:${peer.address().port}`], plugins: HOSTED });
    const g = await v.gather(rid, e2);
    assert.equal(g.kept, 2, `kept ${g.kept}: the agreeing result and the dissent whose transcript names E2 both count`);
    // THE SAME DISSENT, BUT ITS TRANSCRIPT CARRIES E1: refused for E2
    const k3 = schnorr.utils.randomSecretKey(), p3 = schnorr.getPublicKey(k3);
    node.round.recordSignerNodes(rid, [node.round.pubkey, pA, pB, p3]);
    const r3 = signed({ ...own, score: 7, transcriptHash: transcriptBytesHash(tE1), nodePubkey: p3 }, k3);
    peerBody = r3; peerCanonical = tE1;
    const g2 = await v.gather(rid, e2);
    assert.equal(g2.kept, 0, `kept ${g2.kept}: a transcript naming E1 is not E2's`);
  } finally { await node.close(); peer.close(); }
});
