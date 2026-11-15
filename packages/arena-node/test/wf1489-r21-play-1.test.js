// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r21 play-1: round.batch takes a signed batch of NO ticks (no events) as a new chain link, but checkTranscript
// (arena-protocol transcript.js) refuses any tickless batch after the first ("expected tick N, got undefined"). One such batch
// from the player and every later mark is still receipted, yet the stored and the canonical transcript can never be built:
// GET /transcript, resume and the close (canonicalTranscript -> checkTranscript) throw for that run at every seat (#342 shape).
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

test('r21-play-1: a seat never takes a batch that leaves its stored transcript unbuildable', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const s = await stage(node);
    const me = await talk(node.port);
    const sign = (b) => signedBatchOf(b, (id) => ed25519.sign(id, s.decoyKey));
    const b1 = { roundId: s.rid, entryId: s.decoy, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 6 }, (_, i) => [65536, i, 0, 0, 0]), liquidations: [] };
    assert.equal(await me.say(sign(b1)), '6');
    // the modified client's one extra frame: a signed batch with no ticks and no events
    const empty = { roundId: s.rid, entryId: s.decoy, previousHash: batchId(b1), firstTick: 6, ticks: [], liquidations: [] };
    const said = await me.say(sign(empty));
    // and the run goes on as usual: the next batch and a mark naming it are taken and receipted
    const b2 = { roundId: s.rid, entryId: s.decoy, previousHash: batchId(empty), firstTick: 6,
      ticks: Array.from({ length: 6 }, (_, i) => [65536, 6 + i, 0, 0, 0]), liquidations: [] };
    const said2 = await me.say(sign(b2));
    const m = { roundId: s.rid, entryId: s.decoy, tick: 12, stateHash: b32(9), inputChainHash: batchId(b2), previousHash: NO_PREVIOUS };
    const rc = await me.say(joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), s.decoyKey)));
    me.shut();
    let served = null;
    try { node.round.handOver(s.rid, s.decoy); served = 'ok'; } catch (x) { served = x.message; }
    assert.equal(served, 'ok', `empty batch answered ${JSON.stringify(said)}, next batch ${JSON.stringify(said2)}, mark ${rc instanceof Uint8Array ? 'receipted' : rc}; `
      + `then the seat cannot build the run's transcript: ${served}`);
  } finally { await node.close(); }
});
