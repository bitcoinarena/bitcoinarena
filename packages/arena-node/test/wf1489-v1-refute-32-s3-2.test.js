// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-32 skeptic 3 (second copy of the #1802 logic): verify.js signersNaming, which server.js takeAcceptedEntry uses to
// take an entry PAST THIS SEAT'S DOOR once the threshold "signed a result naming it" (§17, #1071), counts every committee-signed result about
// the round and the entry's PLAYER - but a PlayerResult never names its entry. A peer that answers /results?entry=E2 with the committee's
// real results for the same player's E1 makes E2 look signed by the threshold, so a seat takes in an entry no seat ever signed.
// Safe: signersNaming counts 0 for E2 when the only results served are E1's.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';

test('#1489 v1-refute-32-s3-2: signersNaming does not count the committee\'s E1 results as naming E2', async () => {
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
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../../nextblock/dist/blwp-core.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  // two OTHER honest committee members (their secrets only sign their true results)
  const kA = schnorr.utils.randomSecretKey(), kB = schnorr.utils.randomSecretKey();
  const pA = schnorr.getPublicKey(kA), pB = schnorr.getPublicKey(kB);
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  let peerBody = new Uint8Array(0);
  const peer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(peerBody)); });
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
    // THE COMMITTEE'S TRUE RESULTS FOR E1 (score 999999, transcript 9) - signed by A and B, as they would sign E1
    const forE1 = [[kA, pA], [kB, pB]].map(([k, p]) => signed({ roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 999999, transcriptHash: b32(9), simCoreHash: TRUCK_CORE_HASH, nodePubkey: p }, k));
    const cat = new Uint8Array(forE1.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of forE1) { cat.set(b, at); at += b.length; }
    peerBody = cat;
    const v = new Verifier(node.round, { peers: [`http://127.0.0.1:${peer.address().port}`], plugins: HOSTED });
    const s = await v.signersNaming(rid, e2, b32(5));
    assert.equal(s.size, 0, `signersNaming counted ${s.size} committee signers for E2 from results that are E1's`);
  } finally { await node.close(); peer.close(); }
});
