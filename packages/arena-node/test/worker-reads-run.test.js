// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REPLAY WORKER READS THE RUN OUT OF THE STORE ITSELF (2026-09-17 19:15, the ghost lag).
//
// The close used to read every entry's rows on the daemon's own thread - the thread that answers /play and pushes a
// pictured truck - and hand them across. Measured live: a close held that loop 554-1511 ms before it waited, with a
// transcript read 21-31 ms of each of up to seven entries. Now the worker is given the store's path and the two ids
// and reads them itself. What it must NOT change is the answer: same outcome, same state hash, same everything.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replayInWorker } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
  feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

test('a worker handed a store and two ids replays exactly what a worker handed the rows replays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-worker-read-'));
  const path = join(dir, 'store.db');
  try {
    const store = openStore(path);
    assert.equal(store.arenaPath, path, 'the store does not say where it is, so no worker can read it');
    assert.equal(openStore().arenaPath, null, 'an in-memory store named a file');
    const round = new Round(store, () => 1234, { plugins: HOSTED });
    const rid = round.open(contract());
    const entry = entryFor(rid);
    const eid = round.enter(entry);
    let previousHash = GENESIS;
    const TICKS = 600, CHUNK = 100;
    for (let i = 0; i < TICKS; i += CHUNK) {
      const b = {
        roundId: rid, entryId: eid, previousHash, firstTick: i,
        ticks: Array.from({ length: CHUNK }, (_, k) => [45875, ((i + k) * 977) % 30000 - 15000, 0, 0, 0]),
        liquidations: [], loads: [], samples: i === 200 ? [[250, 76700 * 256]] : [], tapes: [],
      };
      assert.equal(round.batch(encodeInputBatch(b)), CHUNK);
      previousHash = batchId(b);
    }

    const options = { core: TRUCK, roundRandomness: b32(0xbe) };
    const handed = await replayInWorker(round.transcript(rid, eid), entry, options);
    const read = await replayInWorker(null, entry, { ...options, source: { store: path, roundId: rid, entryId: eid } });
    assert.equal(handed.ok, true, handed.why);
    assert.equal(read.ok, true, read.why);
    assert.deepEqual(read, handed, 'a worker that read the run itself answered something else');

    // AND A STORE THAT IS NOT THERE IS A REFUSAL, not a replay of nothing.
    const missing = await replayInWorker(null, entry, { ...options, source: { store: join(dir, 'no.db'), roundId: rid, entryId: eid } })
      .then((r) => r, (e) => ({ ok: false, why: e.message }));
    assert.equal(missing.ok, false, 'a worker replayed a store that does not exist');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
