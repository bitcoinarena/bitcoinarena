// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-nostr-1: THE SIGNED NOSTR RESULT (kind 30762) SAYS ONLY WHAT THE ROUND'S COMMITTEE SIGNED.
// nostrResultOf (server.js) tallied every row of round.results() by (outcome, score) and took the most common one - with no check
// that the row's signer is in the round's committee, nor that its signature holds. A peer pull (verify.js #keepPeerResult) stores a
// result signed by ANY key a peer hands in (it checks round, player and the signature under the key the result names - not that
// the key is a signer node), so one bad seat serving /results with two results under fresh keys out-votes the committee's own
// result, and every honest node then signs and publishes (once, never replaced) an event naming the attacker's score and rank.
// Safe: the event carries the committee's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

test('#1489 r1-nostr-1: results signed by keys outside the committee do not change the node\'s signed Nostr result', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
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
  const session = ed25519.utils.randomSecretKey();
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify: () => true });
    const rid = await client.openRound({
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
    });
    const eid = await client.join({
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    });
    if (!node.round.signerNodes(rid).length) node.round.recordSignerNodes(rid, [node.round.pubkey]);
    assert.deepEqual(node.round.signerNodes(rid).map(toHex), [toHex(node.round.pubkey)], 'the committee is this one node');
    // THE COMMITTEE'S RESULT: score 42
    const put = (res, secret) => {
      const body = encodePlayerResult(res);
      const id = resultId(res);
      const sig = secret ? schnorr.sign(id, secret) : new Uint8Array(64);
      node.round.putResult(Buffer.from(rid), Buffer.from(eid), Buffer.from(res.nodePubkey), Buffer.from(id), Buffer.from(joinSignedResult(body, sig)));
    };
    put({ roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 42, transcriptHash: b32(3), simCoreHash: TRUCK_CORE_HASH, nodePubkey: node.round.pubkey });
    // TWO RESULTS UNDER FRESH KEYS (no seat of the round), each validly signed by its own key - what #keepPeerResult stores from a peer
    for (let i = 0; i < 2; i++) {
      const k = schnorr.utils.randomSecretKey();
      put({ roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 999999, transcriptHash: b32(9), simCoreHash: TRUCK_CORE_HASH, nodePubkey: schnorr.getPublicKey(k) }, k);
    }
    node.round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
    const res = await fetch(`http://127.0.0.1:${node.port}/nostr-results?round=${toHex(rid)}`);
    assert.equal(res.status, 200);
    const e = await res.json();
    assert.equal(e.pubkey, toHex(node.round.pubkey), 'signed by the honest node');
    const c = JSON.parse(e.content);
    assert.equal(c.entries[0].score, 42, `the node signed and published score ${c.entries[0].score}: two outsider keys out-voted the committee's own result`);
  } finally { await node.close(); }
});
