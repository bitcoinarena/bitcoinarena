// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Ghosts, GHOST_RUNS_KEEP } from "../src/ghosts.js";
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
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
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

// kanban #1489 skeptic 2 of #1820, attacker role: a PLAYER (not a watcher) who puts more drivers into open rounds at one seat than
// GHOST_RUNS_KEEP. The fix's LRU then lets go a run that is still being driven and watched, and the next picture of it starts
// again from its join tick: every batch of every driver re-walks its whole run (up to 8 x STEP_BUDGET ticks in the warm step,
// on the event loop the seat's signer work shares) instead of the ticks since the last one - before the fix each run stayed warm.
// Safe: a picture asked of a driven run after one new tick walks that one tick (about one per driver), not the run again.

// kanban #1489 skeptic 3 of #1820 (after #2316), attacker role: drivers who STOP. #2316 lets a held run go for room only when
// its round is no longer OPEN or the run reached its last tick. A truck whose driver closed the tab (or an attacker's cheap
// entries, each driving a few ticks then nothing) never reaches its last tick while its round stays open, so once
// GHOST_RUNS_KEEP such runs were pictured once (any watcher of that round does it: setFor pictures every entry), the seat
// refuses to picture ANY new truck of ANY open round until that round closes - the LRU of #1820 let the stalled ones go.
// Safe: a new, live driver in another open round is pictured while stalled runs sit in the table.
test('wf1489-a45-refute-19-s3-1: GHOST_RUNS_KEEP stalled runs of an open round lock every new truck out of the ghost picture', { timeout: 280000 }, () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  const T = 5;
  const stalledRound = round.open(contract(140700n));
  for (let i = 0; i < GHOST_RUNS_KEEP; i++) {
    const eid = round.enter(entryFor(stalledRound, i));
    const rows = []; for (let t = 0; t < T; t++) rows.push(wordsAt(t));
    round.batch(encodeInputBatch({ roundId: stalledRound, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [], loads: [] }));
  }
  // ONE WATCHER OF THAT ROUND: every entry pictured once, then nobody drives on
  ghosts.setFor(stalledRound, new Uint8Array(32));
  const held = ghosts.runs.size;
  // AN HONEST DRIVER IN ANOTHER OPEN ROUND, driving now
  const live = round.open(contract(140701n));
  const eid = round.enter(entryFor(live, 9000));
  const rows = []; for (let t = 0; t < 20; t++) rows.push(wordsAt(t));
  round.batch(encodeInputBatch({ roundId: live, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [], loads: [] }));
  const fresh = ghosts.latest(live, eid);
  console.log(`FACTS ${held} stalled runs held (each at tick ${T - 1} of an open round); the live driver: ${fresh.ok ? 'pictured at ' + fresh.ghost.tick : 'refused: ' + fresh.why}`);
  assert.ok(fresh.ok, `a live truck is not pictured because ${held} stalled runs of an open round hold every slot: ${fresh.why}`);
  assert.equal(fresh.ghost.tick, 19);
});
