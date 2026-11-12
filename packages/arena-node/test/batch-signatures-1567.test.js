// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1567 (feedback #013 by Hexbox Tools): the seat keeps each batch's signature beside it and serves them on
// GET /batch-signatures - 64 bytes per batch in the transcript's order, zeros where it took a batch bare - so a reloaded
// page re-publishes only batches it can show it signed. A /first-mark hand-on carries them; only ones that verify are kept.
// Stored batch bytes, ids and chains are unchanged.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId, signedBatchOf, joinSignedBatch } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { assumeStakeSeen } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';

const FUNDED = { funded: () => true };
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, sessionPubkey, who) => ({
  roundId: rid, playerPubkey: b32(who), sessionPubkey,
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

// A round with two players: the victim, whose public entry id the attacker knows, and the attacker's own (the decoy).
async function stage(node) {
  const victimKey = ed25519.utils.randomSecretKey();
  const decoyKey = ed25519.utils.randomSecretKey();
  const rid = (await post(node.port, '/round', encodeRoundContract(contract()))).bytes;
  const ve = entryFor(rid, ed25519.getPublicKey(victimKey), 5);
  const de = entryFor(rid, ed25519.getPublicKey(decoyKey), 6);
  const victim = (await post(node.port, '/entry', encodeEntryContract(ve))).bytes;
  const decoy = (await post(node.port, '/entry', encodeEntryContract(de))).bytes;
  assert.equal(victim.length, 32, 'the victim joined');
  assert.equal(decoy.length, 32, 'the decoy joined');
  assumeStakeSeen(node.round, ve);
  assumeStakeSeen(node.round, de);
  return { rid, victim, decoy, victimKey, decoyKey };
}
// Hexbox's forged batch: 120 hostile ticks and a load the victim never declared.
const hostile = (rid, eid, previousHash = GENESIS) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: 0,
  ticks: Array.from({ length: 120 }, () => [-65536, 65536, 65536, 0, 0]), liquidations: [], loads: [[0, 99999, 9999]],
});
const honest = (rid, eid, previousHash = GENESIS, first = 0, n = 60) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: first,
  ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [],
});
const stored = (node, rid, eid) => node.round.transcript(rid, eid);


const sigsAt = async (node, rid, eid) => new Uint8Array(await (await fetch(`http://127.0.0.1:${node.port}/batch-signatures?round=${toHex(rid)}&entry=${toHex(eid)}`)).arrayBuffer());

test('#1567 /play keeps each batch\'s signature beside it, served in chain order; the stored batch is unchanged', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const s = await stage(node);
    const me = await talk(node.port);
    const b1 = honest(s.rid, s.victim);
    const b2 = honest(s.rid, s.victim, batchId(b1), 60, 30);
    const f1 = signedBatchOf(b1, (id) => ed25519.sign(id, s.victimKey));
    assert.equal(await me.say(f1), '60');
    assert.equal(await me.say(signedBatchOf(b2, (id) => ed25519.sign(id, s.victimKey))), '30');
    me.shut();
    const sigs = await sigsAt(node, s.rid, s.victim);
    assert.equal(sigs.length, 128, 'one signature per batch');
    assert.ok(ed25519.verify(sigs.subarray(0, 64), batchId(b1), ed25519.getPublicKey(s.victimKey)));
    assert.ok(ed25519.verify(sigs.subarray(64), batchId(b2), ed25519.getPublicKey(s.victimKey)));
    assert.deepEqual(toHex(f1.subarray(f1.length - 64)), toHex(sigs.subarray(0, 64)), 'the very signature the player sent');
    const row = node.round.db.prepare('SELECT bytes FROM batches WHERE entry_id = ? ORDER BY seq').get(s.victim);
    assert.equal(toHex(new Uint8Array(row.bytes)), toHex(encodeInputBatch(b1)), 'the stored batch is the bare batch, as before');
    // a batch written straight into the store (what a forging seat does) has no signature: zeros
    node.round.batch(encodeInputBatch({ ...hostile(s.rid, s.victim, batchId(b2)), firstTick: 90, loads: [] }));
    const after = await sigsAt(node, s.rid, s.victim);
    assert.equal(after.length, 192);
    assert.ok(after.subarray(128).every((x) => x === 0), 'a bare batch is served with zeros');
    const bad = await fetch(`http://127.0.0.1:${node.port}/batch-signatures?round=00&entry=00`);
    assert.equal(bad.status, 400);
  } finally { await node.close(); }
});

test('#1567 /first-mark hand-on: the batches\' signatures travel with them, and only ones that verify are kept', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const s = await stage(node);
    const vb = honest(s.rid, s.victim);
    const vb2 = honest(s.rid, s.victim, batchId(vb), 60, 30);
    const m = { roundId: s.rid, entryId: s.victim, tick: 90, stateHash: b32(3), inputChainHash: batchId(vb2), previousHash: NO_PREVIOUS };
    const mark = joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), s.victimKey));
    const good = ed25519.sign(batchId(vb), s.victimKey);
    const wrong = ed25519.sign(batchId(vb2), s.decoyKey);     // another key: dropped, not a refusal
    const r = await fetch(`http://127.0.0.1:${node.port}/first-mark`, { method: 'POST',
      body: JSON.stringify({ mark: toHex(mark), batches: [toHex(encodeInputBatch(vb)), toHex(encodeInputBatch(vb2))], signatures: [toHex(good), toHex(wrong)], receipt: null }) });
    assert.equal(r.status, 200, 'the endorsed chain is taken as before');
    assert.equal(stored(node, s.rid, s.victim).ticks.length, 90);
    const sigs = await sigsAt(node, s.rid, s.victim);
    assert.equal(toHex(sigs.subarray(0, 64)), toHex(good), 'the verified signature is kept');
    assert.ok(sigs.subarray(64).every((x) => x === 0), 'the one under another key is not');
    // and the player's own signed frame later fills the gap without changing the row
    const me = await talk(node.port);
    assert.equal(await me.say(signedBatchOf(vb2, (id) => ed25519.sign(id, s.victimKey))), '0', 'a repeat, as ever');
    me.shut();
    const now = await sigsAt(node, s.rid, s.victim);
    assert.ok(ed25519.verify(now.subarray(64), batchId(vb2), ed25519.getPublicKey(s.victimKey)), 'the signature is added beside the held batch');
  } finally { await node.close(); }
});
