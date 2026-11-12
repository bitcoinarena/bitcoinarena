// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-32 skeptic 4 (the #1802/#1918 tie of #1512): THE TIE RUNS BEFORE ANY KEY OR SIGNATURE CHECK.
// #gather files every record that merely decodes into `pending` by the transcript hash it names, and asks every peer's /canonical
// (PEER_WAIT_MS 2500 each, sequentially, plus /reveals for head-to-head) once per DISTINCT hash - before #keepPeerResult checks the
// round, the player, the committee key or the signature. Any peer (no key needed) answering /results with N junk records naming N
// hashes, and holding /canonical open, stalls one entry's close gather N x 2.5 s and makes every honest peer serve its transcript N
// times. Before #1802 those records were refused locally in microseconds. Safe: only a record that passes #keepPeerResult's
// round/player/committee/signature checks is tied (as signersNaming already does), so junk costs no peer ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';

test('#1489 v1-refute-32-s4-1: garbage records in one peer\'s /results do not make the gather ask /canonical once per record', async () => {
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
  let canonicalAsks = 0;
  const peer = http.createServer((req, res) => {
    if (req.url.startsWith('/canonical')) { canonicalAsks++; return; }       // a slow peer: never answers, each ask waits out PEER_WAIT_MS
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(peerBody));
  });
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
    // N RECORDS THAT ARE NOBODY'S RESULT: outside keys, zero signatures, each naming a different transcript hash
    const N = 6;
    const junk = [];
    for (let i = 0; i < N; i++) {
      const p = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
      const th = new Uint8Array(32); th[0] = 0xa0 + i; th[31] = i;
      junk.push(joinSignedResult(encodePlayerResult({ roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: th, simCoreHash: TRUCK_CORE_HASH, nodePubkey: p }), new Uint8Array(64)));
    }
    const cat = new Uint8Array(junk.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of junk) { cat.set(b, at); at += b.length; }
    peerBody = cat;
    const v = new Verifier(node.round, { peers: [`http://127.0.0.1:${peer.address().port}`], plugins: HOSTED });
    const t0 = Date.now();
    const g = await v.gather(rid, e2);
    const ms = Date.now() - t0;
    assert.equal(g.kept, 0);
    assert.ok(canonicalAsks <= 1, `the gather asked /canonical ${canonicalAsks} times for ${N} records no committee key signed (one ask per junk transcript hash, each before any key or signature check)`);
    assert.ok(ms < 5000, `one entry's close gather took ${ms} ms: ${N} unsigned records from outside keys each held it a full peer timeout`);
  } finally { peer.closeAllConnections(); await node.close(); peer.close(); }
});
