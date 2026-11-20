
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit play r2-1: the #2654 (practice word) and #2655 (player-declared liquidations) refusals in Round.batch apply only
// to rounds naming game 495516ae (Next Block manifest version 1). Every later Next Block manifest (c693585b, b8b88e23,
// 76f50510, 09bfe97a, d325744b, bb29d429, b6f824f7 = version 8, the one seats host now) runs truck cores with the same
// practice shield - so a modified client in a staked version-8 round still signs practice ticks (or LIQ_MAX strikes)
// and every seat stores them and replays the run as the player chose.
// SAFE: a staked round of the current Next Block game refuses practice ticks and non-zero liquidations, as version 1 does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_V3_CONFIG_HASH, TRUCK_7D19_HASH } from '../../nextblock/plugin/nextblock.js';
import { GAME as NEXTBLOCK_V8, GAME_ID_V8 } from '../../nextblock/plugin/nextblock-v8.js';
import { GAME as V1 } from '../../nextblock/plugin/nextblock.js';
import { GAME as V2 } from '../../nextblock/plugin/nextblock-v2.js';
import { GAME as V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { GAME as V4 } from '../../nextblock/plugin/nextblock-v4.js';
import { GAME as V5 } from '../../nextblock/plugin/nextblock-v5.js';
import { GAME as V6 } from '../../nextblock/plugin/nextblock-v6.js';
import { GAME as V7 } from '../../nextblock/plugin/nextblock-v7.js';
// the whole manifest chain, as a seat's launcher hands it (src/main.js adds every version, #1415)
const ALL = [V1, V2, V3, V4, V5, V6, V7, NEXTBLOCK_V8];
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: GAME_ID_V8, simCoreHash: fromHex(TRUCK_7D19_HASH), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], protocolVersion: 11,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 4000n, donationMsat: 6000n, reserveOutpoint: { txid: new Uint8Array(32).fill(9), outIdx: 0n }, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

test('audit-play-r2-1: a staked Next Block v8 run\'s batch with practice ticks is refused at the seat', () => {
  const r = new Round(openStore(), () => 1234, { plugins: ALL });
  const rid = r.open(contract()); const eid = r.enter(entryFor(rid));
  let took = null; let why = null;
  try {
    took = r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 30 }, () => [65536, 0, 0, 0, 65536]), liquidations: [] }));
  } catch (e) { why = e.message; }
  console.log(`[audit-play-r2-1] v8 paid round, 30 practice ticks: took=${took} why=${why}`);
  assert.equal(took, null, 'a practice tick in a staked v8 run is not stored as the player\'s run');
});

test('audit-play-r2-1: a staked Next Block v8 run\'s batch with a player-declared liquidation is refused at the seat', () => {
  const r = new Round(openStore(), () => 1234, { plugins: ALL });
  const rid = r.open(contract()); const eid = r.enter(entryFor(rid));
  let took = null; let why = null;
  try {
    took = r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 30 }, () => [65536, 0, 0, 0, 0]), liquidations: [[5, 65535]] }));
  } catch (e) { why = e.message; }
  console.log(`[audit-play-r2-1] v8 paid round, liquidation strike: took=${took} why=${why}`);
  assert.equal(took, null, 'a player-declared liquidation in a staked v8 run is not stored');
});

// EVIDENCE: version 8's own core (7d197042) still honours the practice word as a shield
import { readFileSync } from 'node:fs';
import { CORE as CORE_7D19 } from '../../nextblock/frozen/7d197042/adapter.js';
const replay = (v, practice) => {
  const st = CORE_7D19.start(v.seed, null, {});
  const ev = CORE_7D19.eventsOf({ liquidations: v.liquidations || [] });
  let res = null;
  for (let t = 0; t < v.ticks; t++) {
    ev.before(st, t);
    const w = v.inputs[t].slice();
    if (practice) w[4] = 65536;
    CORE_7D19.step(st, w);
    res = CORE_7D19.result(st);
    if (res.outcome) return { tick: t + 1, ...res };
  }
  return { tick: v.ticks, ...res };
};
test('audit-play-r2-1: evidence - on core 7d197042 the practice word turns a wrecked run into a delivered one', () => {
  const DIR = new URL('../../nextblock/test-vectors/', import.meta.url).pathname;
  const v = JSON.parse(readFileSync(`${DIR}straight.json`, 'utf8'));
  const honest = replay(v, false), shielded = replay(v, true);
  console.log(`[audit-play-r2-1] 7d197042 straight: honest ${JSON.stringify(honest)} | practice ${JSON.stringify(shielded)}`);
  assert.notEqual(honest.outcome, 'DELIVERED');
  assert.equal(shielded.outcome, 'DELIVERED');
});


// kanban #2991, measured on the live tree: its known-games.js did not list v8 - the hosted games are named to round.js as well
test('#2991: a hosted Next Block version known-games does not list is covered once the seat names its hosted games', async () => {
  const { noteNextblockGames, nextblockGameIds } = await import('../src/round.js');
  const fresh = 'ab'.repeat(32), other = 'cd'.repeat(32);
  noteNextblockGames(new Map([[fresh, { name: 'nextblock' }], [other, { name: 'rock-paper-scissors', manifest: { gameName: 'rock-paper-scissors' } }]]));
  assert.ok(nextblockGameIds().includes(fresh));
  assert.ok(!nextblockGameIds().includes(other));
});
