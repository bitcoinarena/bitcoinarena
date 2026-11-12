// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 skeptic 3 on #1503 / #1857 (honest path). Built on skeptic 2's rig.
// The #1857 fix proves a reloaded tab's batches only by the LAST sent and LAST taken id it kept in storage. A batch the seat
// took whose answer was lost, and that a reconnect's resume then took back, is never written to that store as 'took'. If the
// next batch is then lost in flight (a second drop) and the tab is reloaded, the store holds { took: A, sent: D } while the
// seat holds A, C: C - the player's own, honestly taken batch - is disowned, the run restarts at C's first tick, and the
// seat refuses every batch from there (its head is C). An honest player's run is lost to two drops and a reload.
// ORIGINAL HEADER: KANBAN #1489 skeptic 2 on #1503 (feedback #012): batches are taken only signed by the entry's session key - but the
// client's resume (a dropped socket, or a page reload) re-signs EVERY batch the home seat's /transcript serves beyond what
// it published itself, and feeds those signed frames to every peer. So ONE SEAT - the player's home seat - writes a forged
// batch (ticks and a load the player never made) into its own store, waits for the player's reconnect or reload, and the
// player's own client signs that batch and carries it to the honest seats. The forged ticks land at a seat that never
// trusted the home seat, exactly the effect #1503 closed for a stranger.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId, signedBatchOf } from '../../arena-protocol/src/batch.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { Client } from '../src/client.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, sessionPubkey) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
};
const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  sock.binaryType = 'arraybuffer';
  const said = [];
  sock.addEventListener('message', (e) => { const v = said.shift(); if (v) v(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); });
  sock.addEventListener('open', () => resolve({ say: (m) => new Promise((r) => { said.push(r); sock.send(m); }), shut: () => sock.close() }));
});
const honest = (rid, eid, previousHash = GENESIS, first = 0, n = 60) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: first,
  ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [],
});
// the home seat's fabrication: 60 more ticks hard left the player never steered (#1488 already bounds what a load may say)
const forged = (rid, eid, previousHash) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: 60,
  ticks: Array.from({ length: 60 }, () => [-65536, 65536, 65536, 0, 0]), liquidations: [],
});


test('#1857 skeptic 3: a batch a reconnect took back stays the player\'s own across a later reload', async () => {
  const seat = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });   // an HONEST home seat
  try {
    const key = ed25519.utils.randomSecretKey();
    const rc = encodeRoundContract(contract());
    const rid = (await post(seat.port, '/round', rc)).bytes;
    const e = entryFor(rid, ed25519.getPublicKey(key));
    const eid = (await post(seat.port, '/entry', encodeEntryContract(e))).bytes;
    assumeStakeSeen(seat.round, e);
    const mem = new Map();
    const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
    const sign = (id) => ed25519.sign(id, key);
    const where = { roundId: rid, entryId: eid };
    const tab = new Client({ base: `http://127.0.0.1:${seat.port}`, core, sign, verify, ownBatchStore: store });
    tab.setRound({ ...where, blockTicks: BLOCK_TICKS });
    const sock = await talk(seat.port);
    const words = (first) => Array.from({ length: 60 }, (_, i) => [65536, first + i, 0, 0, 0]);
    // batch A: delivered and answered
    tab.send = async (bytes) => String(await sock.say(bytes));
    assert.equal((await tab.batch(words(0), where)).accepted, 60);
    // batch C: the seat takes it, the answer is lost with the socket
    tab.send = async (bytes) => { await sock.say(bytes); return 'closed: the socket closed'; };
    assert.equal((await tab.batch(words(60), where)).accepted, undefined);
    // the reconnect's resume takes C back as the player's own (in memory)
    const r1 = await tab.resume(where);
    assert.equal(r1.nextTick, 120, 'the reconnect resumes after C');
    // batch D: lost in flight on a second drop, never reaches the seat
    tab.send = async () => 'closed: the socket closed';
    await tab.batch(words(120), where);
    sock.shut();
    // THE TAB IS RELOADED: same session key, same storage
    const back = new Client({ base: `http://127.0.0.1:${seat.port}`, core, sign, verify, ownBatchStore: store });
    const r2 = await back.resumeAfterReload({ ...where, blockTicks: BLOCK_TICKS });
    console.log(`  kept ${JSON.stringify([...mem.values()])}; reload: nextTick ${r2.nextTick}, batches ${r2.batches}, disowned ${back.batchesDisowned} (${back.batchesDisownedWhy})`);
    // and what the seat says to the reloaded tab's next batch
    const s2 = await talk(seat.port);
    back.send = async (bytes) => String(await s2.say(bytes));
    // after the reload the player steers on: new words from the tick the reloaded client resumed at
    const steer = (first) => Array.from({ length: 60 }, (_, i) => [-65536, first + i, 0, 0, 0]);
    const from = back.nextTick;
    const next = await back.batch(steer(from), where);
    s2.shut();
    console.log(`  next batch from tick ${from}: ${JSON.stringify(next.answer)}`);
    assert.equal(r2.nextTick, 120, 'the reloaded run restarts before ticks the seat already holds');
    assert.equal(back.batchesDisowned || 0, 0, 'the player\'s own batch C, taken by an honest seat, is disowned after the reload');
    assert.match(String(next.answer), /^[0-9]+$/, 'the seat refuses the honest player\'s next batch');
  } finally { await seat.close(); }
});
