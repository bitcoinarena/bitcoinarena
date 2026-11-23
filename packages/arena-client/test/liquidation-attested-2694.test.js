// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2694: THE COMMITTEE'S LIQUIDATION goes out at its tick with its signatures (attestation kind 4), as an attested sample does.
// (harness from sample-published.test.js) THE LIVE PRICE REACHES THE NODE ON THE TICK IT WAS HANDED TO THE CORE (2026-09-17 16:01: the chart was frozen -
// nothing ever submitted a price sample). `submitSample` holds the price against the tick the run has reached and
// publishes it with the batch that covers that tick, as a load is; a real node, so what is measured is what it stored.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const FUNDED = { funded: () => true };
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// six more committee keys, so the attestation stands with receiptsNeeded(7) = 5 signatures
const OTHERS = [1, 2, 3, 4, 5, 6].map((n) => b32(0x40 + n));

async function rig(opts = {}) {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED, ...opts });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
    settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey, ...OTHERS.map((sk) => schnorr.getPublicKey(sk))],
  };
  const rid = await client.openRound(c);
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(entry);
  assumeStakeSeen(node.round, entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });
  return { node, client, rid, eid };
}

async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([45875, 6000, 0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* a refusal is a measurement here */ } }
    await wait(2);
    if (!client.hold.length || client.ended) break;
  }
}


test('#2694 an attested liquidation goes out at its tick with its signatures; the node checks and stores it; another tick is refused', async () => {
  const { liquidationEventId } = await import('../../arena-protocol/src/price-sample.js');
  const { node, client, rid, eid } = await rig();
  try {
    await drive(client, 120);
    const tick = client.offered, size = 655360;
    const id = liquidationEventId({ roundId: rid, tick, size });
    const sigs = [[node.round.pubkey, schnorr.sign(id, node.round.identity.secret)], ...OTHERS.slice(0, 4).map((sk) => [schnorr.getPublicKey(sk), schnorr.sign(id, sk)])];
    assert.equal(client.submitAttestedLiquidation({ tick: tick + 1, size, sigs }), false, 'a tick the run is not at');
    assert.equal(client.submitAttestedLiquidation({ tick, size: 0, sigs }), false, 'a strike has a size');
    assert.equal(client.submitAttestedLiquidation({ tick, size, sigs }), true);
    await drive(client, 150);
    const t = node.round.transcript(rid, eid);
    assert.deepEqual(t.liquidations, [[tick, size]], 'the node stored the attested strike');
    assert.equal(client.attests.length, 0, 'the client is still holding the attestation');
    assert.equal(client.liquidations.length, 0, 'the client is still holding the strike');
    assert.equal(client.refusals, 0, 'the node refused the attested batch');
  } finally { await node.close(); }
});

test('#2694 a strike the committee did not sign is refused by the node, and the batch with it', async () => {
  const { node, client } = await rig();
  try {
    await drive(client, 120);
    assert.equal(client.submitAttestedLiquidation({ tick: client.offered, size: 655360, sigs: [[node.round.pubkey, new Uint8Array(64).fill(7)]] }), true);
    await drive(client, 150);
    assert.ok(client.refusals > 0 || client.ended, 'a forged attestation went through');
    assert.match(String(client.refusedWhy), /not attested/);
  } finally { await node.close(); }
});

test('#2694 GET /liquidation-strikes answers what the seat holds and whether the round takes attested strikes', async () => {
  const { node, rid } = await rig();
  try {
    const r = await fetch(`http://127.0.0.1:${node.port}/liquidation-strikes?round=${Buffer.from(rid).toString('hex')}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { liquidations: [], on: false });
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/liquidation-strikes?round=zz`)).status, 400);
  } finally { await node.close(); }
});
