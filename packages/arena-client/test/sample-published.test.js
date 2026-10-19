// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIVE PRICE REACHES THE NODE ON THE TICK IT WAS HANDED TO THE CORE (2026-09-17 16:01: the chart was frozen -
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

const FEE_SATS = 17314, BTC_HUND = 42;

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
    nodes: [node.round.pubkey],
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

test('price samples every 300 ticks ride the batches that cover their ticks, and the node stores them there', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    const want = [];
    for (let k = 1; k <= 3; k++) {
      await drive(client, 300);
      const at = client.offered, price = Math.round((76700 + 17 * k) * 256);
      assert.equal(client.submitSample(price), true);
      want.push([at, price]);
    }
    await drive(client, 150);
    const t = node.round.transcript(rid, eid);
    assert.deepEqual(t.samples, want, 'the node stored different samples from the ones the page submitted');
    assert.equal(client.samples.length, 0, 'the client is still holding published samples');
    for (const [at] of t.samples) assert.ok(at < t.ticks.length, `a sample names tick ${at}, which the transcript does not cover`);
    console.log(`  ${t.ticks.length} ticks; samples stored at ticks ${t.samples.map(([at]) => at).join(', ')}`);
  } finally { await node.close(); }
});

test('a live tape handed over at the start goes out with the first batch and the node stores it at tick zero', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    const tape = Array.from({ length: 64 }, (_, i) => Math.round((76700 + i) * 256));
    assert.equal(client.submitTape(tape.slice(1)), false, 'a short tape was accepted');
    assert.equal(client.submitTape(tape), true);
    await drive(client, 200);
    const t = node.round.transcript(rid, eid);
    assert.deepEqual(t.tapes, [[0, ...tape]], 'the node did not store the live tape at tick zero');
    assert.equal(client.tapes.length, 0, 'the client is still holding the published tape');
  } finally { await node.close(); }
});

test('an ended run submits no more samples', async () => {
  const { node, client } = await rig();
  try {
    client.ended = true;
    assert.equal(client.submitSample(20000000), false);
  } finally { await node.close(); }
});

test('the committee\'s price: an attested sample goes out at its tick with its signatures, the node checks and stores it; another tick is refused', async () => {
  const { priceSampleId, centsToTapeUnits } = await import('../../arena-protocol/src/price-sample.js');
  const { node, client, rid, eid } = await rig();
  try {
    await drive(client, 300);
    const tick = client.offered, cents = 8297193;
    const sigs = [[node.round.pubkey, schnorr.sign(priceSampleId({ roundId: rid, tick, priceCents: cents }), node.round.identity.secret)]];
    assert.equal(client.submitAttestedSample({ tick: tick + 1, priceCents: cents, sigs }), false, 'a tick the run is not at');
    assert.equal(client.submitAttestedSample({ tick, priceCents: cents, sigs }), true);
    await drive(client, 150);
    const t = node.round.transcript(rid, eid);
    assert.deepEqual(t.samples, [[tick, centsToTapeUnits(cents)]], 'the node stored the attested price, in the tape\'s unit');
    assert.equal(client.attests.length, 0, 'the client is still holding the attestation');
    assert.equal(client.refusals, 0, 'the node refused the attested batch');
  } finally { await node.close(); }
});

test('an attestation the committee did not give is refused by the node, and the batch with it', async () => {
  const { node, client } = await rig();
  try {
    await drive(client, 300);
    const tick = client.offered;
    assert.equal(client.submitAttestedSample({ tick, priceCents: 8297193, sigs: [[node.round.pubkey, new Uint8Array(64).fill(7)]] }), true);
    await drive(client, 150);
    assert.ok(client.refusals > 0 || client.ended, 'a forged attestation went through');
    assert.match(String(client.refusedWhy), /not attested/);
  } finally { await node.close(); }
});

test('a seat running the committee\'s feed says so at /price-samples and refuses a bare price; a seat without says feed false', async () => {
  for (const on of [true, false]) {
    const { node, client, rid } = await rig(on ? { priceFeed: { readPrice: async () => 8297193 } } : {});
    try {
      const r = await fetch(`http://127.0.0.1:${node.port}/price-samples?round=${Buffer.from(rid).toString('hex')}`);
      assert.equal((await r.json()).feed, on);
      if (on) {
        // the protocol-5 door is there, and a round below protocol 5 takes no reading at it
        const p = await fetch(`http://127.0.0.1:${node.port}/price-reading`, { method: 'POST', body: JSON.stringify({ round: Buffer.from(rid).toString('hex'), kind: 'sample', k: 1, priceCents: 8297193, key: '00'.repeat(32), signature: '00'.repeat(64) }) });
        assert.equal(p.status, 409); assert.match(await p.text(), /proposed samples: a signed reading is a protocol 5 price/);
      }
      await drive(client, 300);
      assert.equal(client.submitSample(20000000), true);
      await drive(client, 150);
      if (on) { assert.ok(client.refusals > 0, 'a bare price went through a seat running the feed'); assert.match(String(client.refusedWhy), /the player never chooses the price/); }
      else assert.equal(client.refusals, 0, 'a seat without the feed refused a bare price');
    } finally { await node.close(); }
  }
});
