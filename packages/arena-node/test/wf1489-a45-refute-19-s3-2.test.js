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
import { Ghosts, GHOST_RUNS_KEEP, GHOST_IDLE_MS } from "../src/ghosts.js";
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

const drive = (round, d, from, n) => {
  const rows = []; for (let t = from; t < from + n; t++) rows.push(wordsAt(t));
  const batch = { roundId: d.rid, entryId: d.eid, previousHash: d.head, firstTick: from, ticks: rows, liquidations: [], loads: [] };
  round.batch(encodeInputBatch(batch));
  d.head = batchId(batch);
};

// kanban #2374/#2379 (refute 3 of #1820): an idle run may make room, but the #2316 round robin stays closed. More live drivers
// than GHOST_RUNS_KEEP, each one new tick per cycle and every truck pictured each cycle: after the first cycles no run is
// walked again from its join tick - each cycle walks about one tick per held driver.
test('wf1489-a45-refute-19-s3-2: more live drivers than GHOST_RUNS_KEEP, cycle after cycle, never go round robin', { timeout: 280000 }, () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  const N = GHOST_RUNS_KEEP + 6, T = 100;
  const rids = [round.open(contract(140800n)), round.open(contract(140801n))];
  const drivers = [];
  for (let i = 0; i < N; i++) {
    const d = { rid: rids[i % 2], head: GENESIS };
    d.eid = round.enter(entryFor(d.rid, i));
    drive(round, d, 0, T);
    drivers.push(d);
  }
  for (const d of drivers) ghosts.latest(d.rid, d.eid);
  const perCycle = [];
  for (let c = 0; c < 6; c++) {
    for (const d of drivers) drive(round, d, T + c, 1);
    const before = ghosts.walked;
    for (const d of drivers) ghosts.latest(d.rid, d.eid);
    perCycle.push(ghosts.walked - before);
  }
  console.log(`FACTS ${N} drivers, ticks walked per cycle: ${perCycle.join(', ')}; warm runs held ${ghosts.runs.size}`);
  assert.ok(ghosts.runs.size <= GHOST_RUNS_KEEP);
  for (const w of perCycle.slice(1)) assert.ok(w <= N, `a cycle re-walked runs from the join tick: ${perCycle.join(', ')}`);
});

// kanban #2374/#2379: a new truck that took an idle driver's slot gives it back when that driver drives on, then waits only
// for a run idle GHOST_IDLE_MS - and gets it once one is, with no round closing.
test('wf1489-a45-refute-19-s3-2: the slot goes back to a driver who drives on; the new truck gets a long-idle one', { timeout: 280000 }, () => {
  let clock = 1_000_000;
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON, now: () => clock });
  const rid = round.open(contract(140900n));
  const drivers = [];
  for (let i = 0; i < GHOST_RUNS_KEEP; i++) {
    const d = { rid, head: GENESIS }; d.eid = round.enter(entryFor(rid, i)); drive(round, d, 0, 5); drivers.push(d);
    assert.ok(ghosts.latest(rid, d.eid).ok);
  }
  const x = { rid, head: GENESIS }; x.eid = round.enter(entryFor(rid, 7000)); drive(round, x, 0, 5);
  const first = ghosts.latest(rid, x.eid);
  assert.ok(first.ok, `a new truck is not pictured while every held run is idle: ${first.why}`);
  // driver 0, whose slot it took, drives on: pictured again, the slot back
  drive(round, drivers[0], 5, 1);
  const again = ghosts.latest(rid, drivers[0].eid);
  assert.ok(again.ok, again.why); assert.equal(again.ghost.tick, 5);
  // the new truck drives on too: it waits (every other held run was idle only a moment)
  drive(round, x, 5, 1);
  const waits = ghosts.latest(rid, x.eid);
  assert.equal(waits.ok, false);
  // driver 0 asked again with no new tick, then GHOST_IDLE_MS on: the others are long idle, and the new truck gets a slot
  clock += GHOST_IDLE_MS + 1;
  drive(round, drivers[0], 6, 1); assert.ok(ghosts.latest(rid, drivers[0].eid).ok);
  const later = ghosts.latest(rid, x.eid);
  console.log(`FACTS new truck first ${first.ok ? 'pictured' : first.why}; driver 0 back at ${again.ghost.tick}; the new truck then ${waits.ok ? 'pictured' : 'waited'}, after ${GHOST_IDLE_MS} ms idle: ${later.ok ? 'pictured at ' + later.ghost.tick : later.why}`);
  assert.ok(later.ok, later.why); assert.equal(later.ghost.tick, 5);
  assert.ok(ghosts.runs.size <= GHOST_RUNS_KEEP);
});
