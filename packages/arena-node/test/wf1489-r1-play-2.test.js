// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit r1-play-2: the fifth input word, PRACTICE, is the player's own shield, and a staked run takes it.
// In the truck core `practice` withholds every damage (courier fire, armour contact, the crater's irradiation, the
// bombs) and nothing reads S_PRACTICE back: the outcome is DELIVERED all the same. b04de1f8a stopped the honest Unity
// client sending it in a signed run ("tonight's delivered paid runs were invulnerable") - "no node rule". So a modified
// client sets the word on every tick of a paid run, cannot be wrecked, and every seat replays and signs DELIVERED.
// SAFE: a seat refuses a batch with a practice tick in a staked round (or the run's result does not count as delivered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { CORE } from '../../nextblock/src/adapter.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

const replay = (v, practice) => {
  const st = CORE.start(v.seed, null, {});
  const ev = CORE.eventsOf({ liquidations: v.liquidations || [] });
  let res = null;
  for (let t = 0; t < v.ticks; t++) {
    ev.before(st, t);
    const w = v.inputs[t].slice();
    if (practice) w[4] = 65536;
    CORE.step(st, w);
    res = CORE.result(st);
    if (res.outcome) return { tick: t + 1, ...res };
  }
  return { tick: v.ticks, ...res };
};

test('wf1489-r1-play-2: the practice word turns a wrecked run into a delivered one (evidence)', () => {
  const DIR = new URL('../../nextblock/test-vectors/', import.meta.url).pathname;
  const v = JSON.parse(readFileSync(`${DIR}straight.json`, 'utf8'));
  const honest = replay(v, false), shielded = replay(v, true);
  console.log(`[r1-play-2] straight: honest ${JSON.stringify(honest)} | practice on every tick ${JSON.stringify(shielded)}`);
  assert.equal(honest.outcome, 'FAILED');
  assert.equal(shielded.outcome, 'DELIVERED', 'the core replays the shielded run as delivered');
});

test('wf1489-r1-play-2: a staked run\'s batch with practice ticks is refused at the seat', () => {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract()); const eid = r.enter(entryFor(rid));
  let took = null; let why = null;
  try {
    took = r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 30 }, () => [65536, 0, 0, 0, 65536]), liquidations: [] }));
  } catch (e) { why = e.message; }
  console.log(`[r1-play-2] paid round (stake 100000 msat), 30 practice ticks: took=${took} why=${why}`);
  assert.equal(took, null, 'a practice tick in a staked run is not stored as the player\'s run');
});
