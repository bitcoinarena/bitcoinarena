// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GHOSTS ARE REALTIME THROUGH THE NODE (2026-09-17 17:05 / 17:12: "60 s+ delay"). Measured end to end on a real
// daemon at the page's cadence - six ticks every 100 ms from the driver, a watcher subscribed - every picture is the newest
// tick the driver had published when it arrived.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import WebSocket from 'ws';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { watchGhosts, GHOST_BACKLOG, playersLine, newestPose } from '../src/ghost-field.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { encodeEntryContract, entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BEACON = b32(0xbe);
const FUNDED = {
  funded: () => true,
  randomnessFor: () => ({ hash: BEACON, height: 900005, timeMs: 900n }),
};
const words = (n) => (t) => [45875, ((t * (977 + n)) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

async function rig() {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  assumeStakeSeen(node.round, mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });

  // THE OTHER PLAYER, driven straight through the daemon's door: this file is
  // about what the PAGE does with what arrives.
  const theirs = {
    ...mine, playerPubkey: b32(9), sessionPubkey: b32(10), worldSecret: b32(0x59), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(theirs) });
  assumeStakeSeen(node.round, theirs);
  const theirEid = entryIdOf(theirs);
  let head = GENESIS;
  const drive = (first, count, n = 9, entry = theirEid) => {
    const batch = {
      roundId: rid, entryId: entry, previousHash: head, firstTick: first,
      ticks: Array.from({ length: count }, (_, i) => words(n)(first + i)), liquidations: [],
    };
    node.round.batch(encodeInputBatch(batch));
    head = node.round.head(rid, entry);
  };
  return { node, client, rid, eid, theirEid, drive, where: { roundId: rid, entryId: eid } };
}



test('a watcher is shown the driver\'s newest published tick, ten pictures a second, no backlog', async () => {
  const SECONDS = 10;
  const { node, client, rid, theirEid, where } = await rig();
  const sock = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
  try {
    await new Promise((r) => sock.on('open', r));
    sock.on('message', () => {});
    const field = watchGhosts(client, where);
    await field.watching;
    const got = []; const prevOn = client.onGhost;
    client.onGhost = (g) => { if (toHex(g.entryId) === toHex(theirEid)) got.push([Date.now(), g.tick]); prevOn(g); };
    let head = GENESIS, tick = 0; const sentAt = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
      const batch = { roundId: rid, entryId: theirEid, previousHash: head, firstTick: tick, ticks: Array.from({ length: 6 }, (_, i) => words(9)(tick + i)), liquidations: [] };
      sock.send(encodeInputBatch(batch));
      head = batchId(batch); tick += 6; sentAt.push([Date.now(), tick - 1]);
      const w = t0 + (tick / 6) * 100 - Date.now(); if (w > 0) await wait(w);
    }
    await wait(500);
    const lagAt = (wall, t) => { let sent = 0; for (const [w, s] of sentAt) { if (w <= wall) sent = s; else break; } return sent - t; };
    const lags = got.map(([w, t]) => lagAt(w, t)).sort((a, b) => a - b);
    console.log(`  ${got.length} pictures in ${SECONDS} s; behind the newest published tick: median ${lags[lags.length >> 1]}, max ${lags[lags.length - 1]} ticks; last picture tick ${got[got.length - 1][1]} of ${tick - 1}`);
    assert.ok(got.length >= SECONDS * 9, `only ${got.length} pictures in ${SECONDS} s`);
    assert.ok(lags[lags.length - 1] <= 6, `a picture arrived ${lags[lags.length - 1]} ticks behind the newest published tick`);
    assert.equal(got[got.length - 1][1], tick - 1, 'the last picture is not the last tick');
  } finally { sock.close(); await node.close(); }
});

test('a truck that drove before anybody watched is pictured at its newest tick, not replayed from its start', async () => {
  // 2026-09-17 19:15: "in the second round the ghost does not appear reliably - sometimes missing, then at the
  // wrong position". A run was stepped only when a watcher asked, STEP_BUDGET ticks a push, so a truck that drove 20 s
  // alone was first shown 150 ticks into its run.
  const { node, client, rid, theirEid, where } = await rig();
  const sock = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
  try {
    await new Promise((r) => sock.on('open', r));
    const answers = [];
    sock.on('message', (m) => answers.push(String(m)));
    let head = GENESIS, tick = 0;
    for (let n = 0; n < 20; n++) {
      const batch = { roundId: rid, entryId: theirEid, previousHash: head, firstTick: tick, ticks: Array.from({ length: 60 }, (_, i) => words(9)(tick + i)), liquidations: [] };
      sock.send(encodeInputBatch(batch));
      head = batchId(batch); tick += 60;
    }
    for (let i = 0; i < 100 && answers.length < 20; i++) await wait(20);
    assert.equal(answers.filter((a) => a === '60').length, 20, `the node took ${answers.join(',')}`);
    const got = [];
    const field = watchGhosts(client, where);
    const was = client.onGhost;
    client.onGhost = (g) => { if (toHex(g.entryId) === toHex(theirEid)) got.push(g.tick); was(g); };
    await field.watching;
    const batch = { roundId: rid, entryId: theirEid, previousHash: head, firstTick: tick, ticks: Array.from({ length: 6 }, (_, i) => words(9)(tick + i)), liquidations: [] };
    sock.send(encodeInputBatch(batch));
    for (let i = 0; i < 100 && got[got.length - 1] !== tick + 5; i++) await wait(20);
    assert.ok(got.length, 'no picture of the truck that drove');
    assert.equal(got[0], tick - 1, `the first picture shown on watching was tick ${got[0]} of a truck that had published ${tick - 1}`);
    assert.equal(got[got.length - 1], tick + 5, 'the next batch was not the next picture');
  } finally { sock.close(); await node.close(); }
});
