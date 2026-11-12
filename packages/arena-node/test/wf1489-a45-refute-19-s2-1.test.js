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
test('wf1489-a45-refute-19-s2-1: more live drivers than GHOST_RUNS_KEEP re-walk every run from its join tick on each new batch', { timeout: 280000 }, () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  const N = GHOST_RUNS_KEEP + 6, T = 100;
  const rids = [round.open(contract(140500n)), round.open(contract(140501n))];
  const drivers = [];
  for (let i = 0; i < N; i++) {
    const rid = rids[i % 2];
    const eid = round.enter(entryFor(rid, i));
    const rows = []; for (let t = 0; t < T; t++) rows.push(wordsAt(t));
    const batch = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [], loads: [] };
    round.batch(encodeInputBatch(batch));
    drivers.push({ rid, eid, head: batchId(batch) });
  }
  for (const d of drivers) ghosts.latest(d.rid, d.eid);
  // ONE NEW TICK FROM EVERY DRIVER (one batch each, as the page sends), and every truck pictured again
  for (const d of drivers) {
    const batch = { roundId: d.rid, entryId: d.eid, previousHash: d.head, firstTick: T, ticks: [wordsAt(T)], liquidations: [], loads: [] };
    round.batch(encodeInputBatch(batch));
  }
  const before = ghosts.walked; const t0 = Date.now();
  let at = null;
  for (const d of drivers) { const m = ghosts.latest(d.rid, d.eid); at = at ?? (m.ok ? m.ghost.tick : m.why); }
  const walked = ghosts.walked - before;
  console.log(`FACTS ${N} drivers, ${T} ticks then 1 more each: the second pictures walked ${walked} ticks in ${Date.now() - t0} ms (warm: ${N}); first truck at ${at}; warm runs held ${ghosts.runs.size}`);
  assert.equal(at, T);
  assert.ok(walked <= 2 * N, `every picture re-walked its run from the join tick: ${walked} ticks for ${N} new ones`);
});

// kanban #2316: the room past GHOST_RUNS_KEEP comes from runs that are OVER, never from one still being driven. A seat
// holding GHOST_RUNS_KEEP runs that all reached their last tick still warms a new driver's run, and a truck whose run was
// let go for it is still pictured at its last tick without a single tick walked again.
test('wf1489-a45-refute-19-s2-2: past GHOST_RUNS_KEEP an ended run makes room and keeps its last picture', { timeout: 280000 }, () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  const rid = round.open(contract(140600n));
  const late = BLOCK_TICKS - 2;
  const ended = [];
  for (let i = 0; i < GHOST_RUNS_KEEP; i++) {
    const eid = round.enter({ ...entryFor(rid, i), joinTick: late });
    round.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: late, ticks: [wordsAt(late), wordsAt(late + 1)], liquidations: [], loads: [] }));
    const m = ghosts.latest(rid, eid);
    assert.ok(m.ok, `ended run ${i} not pictured: ${m.why}`);
    assert.equal(m.ghost.tick, BLOCK_TICKS - 1);
    ended.push(eid);
  }
  assert.equal(ghosts.runs.size, GHOST_RUNS_KEEP);
  const eid = round.enter(entryFor(rid, 5000));
  round.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [wordsAt(0), wordsAt(1)], liquidations: [], loads: [] }));
  const fresh = ghosts.latest(rid, eid);
  assert.ok(fresh.ok, `a new driver is not pictured although every held run is over: ${fresh.why}`);
  assert.equal(fresh.ghost.tick, 1);
  assert.ok(ghosts.runs.size <= GHOST_RUNS_KEEP);
  const before = ghosts.walked;
  const again = ghosts.latest(rid, ended[0]);
  console.log(`FACTS ${GHOST_RUNS_KEEP} ended runs held, a new driver pictured at ${fresh.ghost.tick}; the run let go pictured at ${again.ok ? again.ghost.tick : again.why}, ${ghosts.walked - before} ticks walked`);
  assert.ok(again.ok, again.why);
  assert.equal(again.ghost.tick, BLOCK_TICKS - 1);
  assert.equal(ghosts.walked - before, 0);
});
