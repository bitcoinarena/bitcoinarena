// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r12 (play): ONE SEAT - the player's home seat - refusing the player's own signed batches ends the run,
// although every other committee seat would take them. Rig: resume-forged-1567.test.js's.
// (was) KANBAN #1567 (feedback #013 by Hexbox Tools): a bypass of #1503. A seat takes a batch only signed by the entry's session
// key - but `resume` signed every batch past `published` that the home seat's GET /transcript served and fed it to every
// peer, never checking that this client recorded it. So one malicious home seat appended a bare forged batch to its own
// store, refused the player's next batch (chain head), and the player's OWN client signed the forgery into the committee;
// a reloaded client (published = []) signed the whole served transcript. Measured on f64efd1bb: the honest peer B stored
// 120 forged ticks as the player's (refusal) and 90 (reload).
//
// Now a resume re-publishes only frames this client signed itself: kept in memory as they are signed, and after a reload
// the seats' own copies of each batch's signature (GET /batch-signatures), each verified under the entry's session key.
// A served batch it cannot show is its own is that seat's fault - nothing of it is signed, nothing goes to a peer.
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
/** The malicious home seat writes a bare batch of `n` hostile ticks onto its own head - no signature, straight into its store. */
function forge(a, rid, eid, n) {
  const first = a.round.nextTick(rid, eid);
  a.round.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: a.round.head(rid, eid), firstTick: first,
    ticks: Array.from({ length: n }, () => HOSTILE), liquidations: [] }));
  return first;
}


test('r12-play-1: the home seat refusing the player\'s signed batches does not keep them from the honest peer, nor end the run', async () => {
  const { a, b, client, rid, eid } = await rig();
  try {
    await drive(client, 60);
    await settle(client, b, rid, eid, 60);
    assert.equal(ticksAt(b, rid, eid).length, 60, 'the honest peer holds the player\'s first 60 ticks');

    // THE HOME SEAT TURNS: it refuses every further batch of this entry (a malicious operator, one seat of the committee)
    a.round.signedBatch = () => { throw new Error('the batch does not follow the chain head'); };
    await drive(client, 120);
    await settle(client, b, rid, eid, 180);

    assert.equal(client.ended, false, `one seat ends the honest run: ${client.endingReason}`);
    assert.ok(ticksAt(b, rid, eid).length >= 180,
      `the honest peer holds only ${ticksAt(b, rid, eid).length} of the player's 180 signed ticks: one refusing home seat keeps them from the committee`);
  } finally { client.close(); await a.close(); await b.close(); }
});
