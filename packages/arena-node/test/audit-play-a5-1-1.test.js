// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT play a5-1-1 (P5): the #1568 rule takes "the very same event" at one tick again as a harmless repeat, so one signed
// batch can carry one zero-size liquidation thousands of times. Every padded batch is stored whole (up to 65,535 bytes),
// and nothing bounds the bytes of one run: a player in a free round (anyone) grows a run far past what a peer or a
// resuming client will ever read (16 MiB) - and on to 65,535 x 64 KiB at every seat.
// SAFE BEHAVIOUR: the seat does not let one run's stored transcript grow past 16 MiB with repeated copies of one event.
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
import { batchId, signedBatchOf } from '../../arena-protocol/src/batch.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
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

const COPIES = 8000;          // one zero-size liquidation, the same event, 8000 times at the batch's one tick (~64 KB a batch)
const BATCHES = 280;          // ~18 MB: past the 16 MiB a peer (PEER_BODY_MAX_BYTES) or a resuming page (TRANSCRIPT_MAX_BYTES) reads
const LIMIT = 16 * 1024 * 1024;

test('audit play a5-1-1: repeated copies of one event per batch grow one run past 16 MiB at the seat', { timeout: 300000 }, async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const key = ed25519.utils.randomSecretKey();
    const rid = (await post(node.port, '/round', encodeRoundContract(contract()))).bytes;
    const e = entryFor(rid, ed25519.getPublicKey(key), 5);
    const eid = (await post(node.port, '/entry', encodeEntryContract(e))).bytes;
    assert.equal(eid.length, 32, 'the entry joined (a free round: anyone)');
    assumeStakeSeen(node.round, e);
    const ws = await talk(node.port);
    let head = GENESIS;
    let took = 0;
    let refused = null;
    for (let i = 0; i < BATCHES; i++) {
      const b = { roundId: rid, entryId: eid, previousHash: head, firstTick: i,
        ticks: [[0, 0, 0, 0, 0]], liquidations: Array.from({ length: COPIES }, () => [i, 0]), loads: [] };
      const frame = signedBatchOf(b, (id) => ed25519.sign(id, key));
      const answer = await ws.say(frame);
      if (String(answer).startsWith('error')) { refused = String(answer); break; }
      took++;
      head = batchId(b);
    }
    ws.shut();
    const row = node.round.db.prepare('SELECT COUNT(*) n, SUM(length(bytes)) bytes FROM batches WHERE round_id = ? AND entry_id = ?').get(rid, eid);
    const t = node.round.handOver(rid, eid);
    console.log(`taken ${took} of ${BATCHES} padded batches${refused ? ` (refused: ${refused.slice(0, 120)})` : ''}; ${row.n} rows, ${row.bytes} stored bytes, GET /transcript ${t.bytes.length} bytes for ${t.ticks} ticks`);
    assert.ok(t.bytes.length <= LIMIT,
      `one run of ${t.ticks} ticks is stored and served as ${t.bytes.length} bytes - past the ${LIMIT} a peer or a resuming page reads; `
      + `each batch repeats one zero-size liquidation ${COPIES} times and every copy is kept`);
  } finally { await node.close(); }
});
