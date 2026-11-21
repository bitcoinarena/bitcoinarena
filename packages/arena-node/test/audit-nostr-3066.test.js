// kanban #3066: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT nostr r3 #1 (attacker audit 2026-11-19, BASE 570bb4f01): the node-signed round result (kind 30762, GET /nostr-results and the
// relays) books each settlement share once PER ENTRY of a key (server.js nostrResultOf: payoutMsat = paid.get(player) for every entry),
// and lists every entry the seat holds. A second entry under the winner's public round key (a stranger's lockless one, kanban #2690/#2835,
// or the player's own second session) makes the signed, published, never-rebuilt result say the pool paid the winner's share twice.
// SAFE: the shares the event books add up to what the settlement paid; a key's share is on one of its entries only (as season-read.js does
// since feedback #109).
import test from 'node:test';
import assert from 'node:assert/strict';

test('the signed Nostr result books a key\'s settlement share once, however many entries the key holds', async () => {
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
  const h = (c) => c.repeat(64);
  const STAKE = BigInt(process.env.AUDIT_STAKE || '0');
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const session = ed25519.utils.randomSecretKey(), other = ed25519.utils.randomSecretKey();
    const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify: () => true });
    const stranger = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, other), verify: () => true });
    const rid = await client.openRound({
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
    });
    const joinAs = (c, sk, world) => c.join({
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(sk),
      stakeCommitment: b32(7), stakeMsat: STAKE, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(world), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    });
    const eid = await joinAs(client, session, 0x5e);            // the winner, round key b32(5)
    const eid2 = await joinAs(stranger, other, 0x6e);           // a second entry under the same public round key
    assert.notEqual(toHex(eid2), toHex(eid));
    // the winner's run signed by the committee, the settlement ACCEPTED, paying the winner's key 12345 msat once
    const signed = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 42, transcriptHash: b32(3), simCoreHash: TRUCK_CORE_HASH, nodePubkey: node.round.pubkey };
    node.round.putResult(Buffer.from(rid), Buffer.from(eid), Buffer.from(node.round.pubkey), Buffer.from(resultId(signed)), Buffer.from(joinSignedResult(encodePlayerResult(signed), new Uint8Array(64))));
    node.round.putLockSettlement({ roundId: rid, txid: h('9'), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
    node.round.putLockSettlementShares(rid, [{ pubkey: b32(5), msat: 12345n }]);
    const res = await fetch(`http://127.0.0.1:${node.port}/nostr-results?round=${toHex(rid)}`);
    assert.equal(res.status, 200, await res.clone().text());
    const c = JSON.parse((await res.json()).content);
    const booked = c.entries.reduce((s, e) => s + BigInt(e.payoutMsat), 0n);
    console.log('FACTS:', JSON.stringify(c.entries.map((e) => ({ entry: e.entry.slice(0, 8), player: e.player.slice(0, 8), outcome: e.outcome, rank: e.rank, payoutMsat: e.payoutMsat }))));
    assert.equal(booked, 12345n, `the node-signed result books ${booked} msat of payouts for a settlement that paid 12345 msat: `
      + `${c.entries.filter((e) => e.payoutMsat !== '0').length} entries under one round key each carry the key's whole share`);
  } finally { await node.close(); }
});
