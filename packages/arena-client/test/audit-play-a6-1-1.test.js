// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3002 - only (1) is tested here; (2), the dropped socket, is its own finding.
// AUDIT play r3-1 (attacker audit 2026-11-18): the #2515 fix ("one seat does not gate publishing") is bypassed by the same
// AUDIT play a6-1-1 (attacker audit 2026-11-22b): the #2515/#3002/#3036 fixes let the peers carry a batch the home seat refuses,
// so the home seat may legitimately hold a shorter chain than `published`. But resume() - the door every reconnect goes
// through - still calls #notBehindPublished, which reads that shorter chain as a node fault and ends the run. So the same
// home seat that refuses one batch (no forgery at all) and then drops the play socket, taking the new one, has the
// player's own client end the honest run: nothing more reaches the honest peers (§15: a stopped run is FAILED).
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { entryId as entryIdOf, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }) };
const HONEST = [45875, 22000, 0, 0, 0];
const HOSTILE = [-65536, 65536, 65536, 0, 0];

async function rig() {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // the home seat - malicious
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // an honest peer
  const session = ed25519.utils.randomSecretKey();
  const sign = (id) => ed25519.sign(id, session);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey],
  };
  const open = async () => {
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, core, sign, verify });
    client.deliverTo([`http://127.0.0.1:${b.port}`]);
    const rid = await client.openRound(contract);
    // the peer holds the round too (a page opens it at every committee node through the lobby; here by hand)
    const r = await fetch(`http://127.0.0.1:${b.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
    assert.ok(r.status === 201 || r.status === 200, `the peer took the round (${r.status})`);
    return { client, rid };
  };
  const { client, rid } = await open();
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(entry);
  assert.deepEqual(eid, entryIdOf(entry));
  for (const n of [a, b]) { assert.ok(n.round.entry(eid), 'both seats hold the entry'); assumeStakeSeen(n.round, entry); }
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: contract.blockTicks });
  return { a, b, client, rid, eid, entry, open, contract };
}

/** Records `n` honest ticks and lets every publish go out. */
async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record(HONEST);
  for (let i = 0; i < 60; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* the refusal is the measurement */ } }
    if (client.recovering) { try { await client.recovering; } catch { /* named on the client */ } }
    await wait(3);
    if ((!client.hold.length && !client.publishing) || client.ended) break;
  }
}
const ticksAt = (node, rid, eid) => node.round.transcript(rid, eid).ticks;
const hostileAt = (node, rid, eid) => ticksAt(node, rid, eid).filter((t) => {
  const w = Array.isArray(t) ? t.slice(-5) : (t.words || t);
  return Array.from(w).join() === HOSTILE.join();
}).length;
async function settle(client, node, rid, eid, want) {
  for (let i = 0; i < 100; i++) {
    client.pumpPeers();
    await wait(20);
    if (ticksAt(node, rid, eid).length >= want) return;
  }
}

test('audit-play-a6-1-1: a home seat that refuses one batch and then drops the socket does not end the honest run on reconnect', async () => {
  const { a, b, client, rid, eid } = await rig();
  try {
    await drive(client, 60);
    await settle(client, b, rid, eid, 60);
    assert.equal(ticksAt(b, rid, eid).length, 60, 'the honest peer holds the player\'s first 60 ticks');

    // THE HOME SEAT TURNS: it refuses every further signed batch of the entry (the plain #2515 refusal, nothing forged)
    a.round.signedBatch = () => { throw new Error('the batch does not follow the chain head'); };
    await drive(client, 60);
    await settle(client, b, rid, eid, 120);
    assert.equal(client.ended, false, `the #2515 peer path holds before the drop: ${client.endingReason}`);
    assert.ok(ticksAt(b, rid, eid).length >= 120, 'the peers carried the batches the home seat refused');

    // ...and then drops the player's play socket; it takes the new one the client opens (a normal reconnect)
    for (const s of a.wss.clients) s.terminate();
    await wait(50);
    try { await Promise.race([client.reconnect(), wait(5000)]); } catch { /* named on the client */ }
    await drive(client, 60);
    await settle(client, b, rid, eid, 180);

    assert.equal(client.ended, false, `one seat ends the honest run through the reconnect: ${client.endingReason}`);
    assert.ok(ticksAt(b, rid, eid).length >= 180,
      `the honest peer holds only ${ticksAt(b, rid, eid).length} of the player's 180 signed ticks`);
  } finally { client.close(); await a.close(); await b.close(); }
});
