// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r6 (play) 1: THE WARM GHOST RUNS ARE NEVER LET GO, AND THE NODE THREAD'S TRUCK CORE DIES OF THEM.
//
// ghosts.js keeps one RunInProgress per (round, entry) it ever pictured in `this.runs`; nothing calls ghosts.forget (no
// caller in src/), not at a round's close, not ever. Each run's state lives in the truck core's sandbox in the NODE's own
// thread (sandboxFor's cache, shared with round.open's runLengthFits) and is dropped only when its RunInProgress is
// collected - which the Map prevents. core-host.js ends a core that keeps more than LIVE_CAP (256 MB) of arrays alive,
// and core-sandbox.js keeps an ended core ended. Measured: after 3,608 pictured runs the core is ended ("it kept more than
// 256 MB of arrays alive"), and from then on that seat pictures no truck of any round AND refuses to open every new
// Tick Tock round (round.open -> runLengthFits -> the core's call throws). Every honest seat reaches it with uptime (any
// watched round's entries count; anyone can watch any round over /play), so the game stops network-wide.
// Safe: a closed round's warm runs are let go; a seat that has pictured thousands of runs of closed rounds still opens
// and pictures a new round.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Ghosts } from '../src/ghosts.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const k32 = (tag, i) => { const a = new Uint8Array(32).fill(tag); a[0] = i & 255; a[1] = (i >> 8) & 255; return a; };
const BEACON = { hash: b32(0x9b), height: 900001, timeMs: 900n };
const contract = (start) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: start, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3,
  rankDenominator: 4, nodes: [b32(4)],
});
const entryFor = (rid, i) => ({
  roundId: rid, playerPubkey: k32(5, i), sessionPubkey: k32(6, i), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: k32(0x5e, i), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

test('wf1489-r6-play-1: a seat that pictured the runs of many closed rounds still opens and pictures a new round', { timeout: 280000 }, () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  const t0 = Date.now();
  let pictured = 0;
  let firstRefusal = null;
  // 40 rounds of 100 drivers each, every one pictured (as a watched round is) and then closed
  for (let r = 0; r < 40; r++) {
    let rid;
    try { rid = round.open(contract(60500n + BigInt(r))); }
    catch (e) { firstRefusal = firstRefusal || `round ${r} not opened: ${e.message}`; break; }
    for (let j = 0; j < 100; j++) {
      const i = r * 100 + j;
      const eid = round.enter(entryFor(rid, i));
      round.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [] }));
      const made = ghosts.latest(rid, eid);
      if (made.ok) pictured++; else if (!firstRefusal) firstRefusal = `run ${i}: ${made.why}`;
    }
    round.close(rid);
  }
  console.log(`FACTS pictured ${pictured} of 4000 runs of 40 closed rounds in ${Date.now() - t0} ms; warm runs still held: ${ghosts.runs.size}; first refusal: ${firstRefusal}`);
  // A NEW ROUND, after all of them have closed
  let opened = null; let why = null;
  try { opened = round.open(contract(70500n)); } catch (e) { why = e.message; }
  console.log(`FACTS a new Tick Tock round after them: ${opened ? 'opened' : `refused: ${why}`}`);
  assert.ok(opened, `the seat refuses every new Tick Tock round: ${why}`);
  const eid = round.enter(entryFor(opened, 9999));
  round.batch(encodeInputBatch({ roundId: opened, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [] }));
  const fresh = ghosts.latest(opened, eid);
  assert.ok(fresh.ok, `the new round's truck is not pictured: ${fresh.why}`);
  assert.equal(firstRefusal, null, `pictures of live rounds were refused: ${firstRefusal}`);
});
