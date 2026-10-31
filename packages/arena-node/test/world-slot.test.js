// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO PLAYERS OF A SHARED WORLD, TWO DOORS (kanban #828, the owner 2026-10-31: "Die 2 Trucks starten auch im selben Launch Slot, das darf
// nicht sein"). The real replay path: replay() into the core's sandbox, off files checked against the core's hash, as ghosts.js and
// verify.js resolve a round's core - against the page's own stepping, the browser bundle started the way arena.jslib starts it.
// A run's place comes from its entry (seed.js worldSlot), so a seat and a page reach it apart, and must arrive at one state hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { replay, replayInWorker, RunInProgress } from '../src/replay.js';
import { hostedPlugins } from '../src/plugins.js';
import { HOSTED } from './plugins/hosted.js';
import { TRUCK_8CBC, TRUCK_0847, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, TRUCK_SHARED_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { worldSeedWord, worldSlot, seedWordForEntry, WORLD_SLOTS } from '../../arena-protocol/src/seed.js';
import { roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { O_TRUCK, T_Z } from '../../nextblock/frozen/8cbc74b2/state.js';
import { bayZ, slotBay, spawnBay } from '../../nextblock/frozen/8cbc74b2/sim.js';

const require = createRequire(import.meta.url);
const PAGE_CORE = require('../../nextblock/dist/core-8cbc74b2.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const TICKS = 600, MARK_EVERY = 90;
const RAND = b32(0xbe);
const zero = new Uint8Array(32);

const contractOf = (configHash) => ({
  networkId: NETWORK_ID_REGTEST, configHash, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
});
const entryOf = (contract, session, worldSecret = zero) => ({
  roundId: roundIdOf(contract), playerPubkey: b32(5), sessionPubkey: session, stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret, vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
// AS GHOSTS.JS AND VERIFY.JS RESOLVE A ROUND'S CORE: the game's shared-world configs, off its registration
const game = hostedPlugins(HOSTED).get(toHex(NEXTBLOCK_GAME_ID));
const worldOf = (contract) => ({ configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: roundIdOf(contract), sharedWorld: [...game.sharedWorld] });
const shared = contractOf(TRUCK_SHARED_CONFIG_HASH);
const session = (i) => { const k = new Uint8Array(32); k[0] = i; k[31] = 0x5a; return k; };
const slotOf = (e, contract = shared) => worldSlot({ entry: e, contract, sharedWorld: [...game.sharedWorld] });
/** Two entries of one round on different places, with different session keys and nothing else. */
const twoApart = () => {
  const a = entryOf(shared, session(1));
  for (let i = 2; ; i++) { const b = entryOf(shared, session(i)); if (slotOf(b) !== slotOf(a)) return [a, b]; }
};
const drive = (t) => [65536, ((t / 45) | 0) % 2 ? 9000 : -9000, 0, 0, 0];
const transcript = { ticks: Array.from({ length: TICKS }, (_, t) => ({ tick: t, words: drive(t) })), liquidations: [], loads: [], samples: [], tapes: [] };

/** THE PAGE: the browser bundle, started as arena.jslib starts a run, its words stepped, a mark every MARK_EVERY ticks. */
function pageRun(e, contract, { slot } = {}) {
  const seedWord = worldSeedWord({ entry: e, roundRandomness: RAND, contract, roundId: roundIdOf(contract), sharedWorld: [...game.sharedWorld] }) | 0;
  const st = PAGE_CORE.init(seedWord, { runTicks: TICKS, ...(slot === undefined ? {} : { slot }) });
  const z0 = st.i32[O_TRUCK + T_Z];
  const marks = [{ tick: 0, stateHash: fromHex(PAGE_CORE.hash(st)) }];
  for (let t = 0; t < TICKS; t++) {
    PAGE_CORE.step(st, ...drive(t));
    if ((t + 1) % MARK_EVERY === 0) marks.push({ tick: t + 1, stateHash: fromHex(PAGE_CORE.hash(st)) });
  }
  return { seedWord, z0, marks, final: PAGE_CORE.hash(st) };
}
const core = (contract, c = TRUCK_8CBC) => ({ ...c, runTicks: TICKS, world: worldOf(contract) });

test('a slot is a place of 0 to 11, and two entries of one round on different slots start at different doors of the round\'s one world', () => {
  const [a, b] = twoApart();
  for (const e of [a, b]) assert.ok(Number.isInteger(slotOf(e)) && slotOf(e) >= 0 && slotOf(e) < WORLD_SLOTS);
  const pa = pageRun(a, shared, { slot: slotOf(a) }), pb = pageRun(b, shared, { slot: slotOf(b) });
  assert.equal(pa.seedWord, pb.seedWord, 'one world');
  assert.equal(pa.z0, bayZ(slotBay(pa.seedWord, slotOf(a))));
  assert.equal(pb.z0, bayZ(slotBay(pb.seedWord, slotOf(b))));
  assert.notEqual(pa.z0, pb.z0);
  const metres = Math.abs(pa.z0 - pb.z0) / 65536;
  console.log(`  #828 slots ${slotOf(a)} and ${slotOf(b)}: bays ${slotBay(pa.seedWord, slotOf(a))} and ${slotBay(pb.seedWord, slotOf(b))} of 0-23 around ${spawnBay(pa.seedWord)}, ${metres.toFixed(1)} m apart`);
  assert.ok(metres >= 6.7 && metres < 75, 'side by side, within sight');
});

test('the seats\' replay in the sandbox reaches the page\'s state hash at every mark, for both players, with the slot derived on each side', () => {
  for (const e of twoApart()) {
    const page = pageRun(e, shared, { slot: slotOf(e) });
    const r = replay(transcript, e, { core: core(shared), roundRandomness: RAND, marks: page.marks, pictures: [0] });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.checked, page.marks.length, 'every mark was checked');
    assert.equal(r.divergedAt, null, 'the replay parted from the page');
    assert.equal(r.stateHash, page.final);
    assert.equal(r.coreHash, TRUCK_8CBC.hash);
  }
});

test('a page that forgets the slot parts from the seats at the first mark: the slot really is in the replay', () => {
  const e = entryOf(shared, session(1));
  const r = replay(transcript, e, { core: core(shared), roundRandomness: RAND, marks: pageRun(e, shared).marks });
  assert.equal(r.ok, true, r.why);
  // spawnBay's own door is one of the twelve: only then is the run without a slot the same run
  const same = bayZ(slotBay(pageRun(e, shared).seedWord, slotOf(e))) === bayZ(spawnBay(pageRun(e, shared).seedWord));
  assert.equal(r.divergedAt, same ? null : 0);
});

test('the worker\'s replay and the warm ghost run take the same place as the cold replay', async () => {
  const [a] = twoApart();
  const page = pageRun(a, shared, { slot: slotOf(a) });
  const inWorker = await replayInWorker(transcript, a, { core: core(shared), roundRandomness: RAND, marks: page.marks });
  assert.equal(inWorker.ok, true, inWorker.why);
  assert.equal(inWorker.stateHash, page.final);
  const cold = replay(transcript, a, { core: core(shared), roundRandomness: RAND, pictures: [300] });
  const warm = new RunInProgress(a, { core: core(shared), roundRandomness: RAND });
  assert.equal(warm.ok, true, warm.why);
  warm.stepTo(transcript, 300);
  assert.deepEqual(warm.pose(), cold.pictures[0]);
});

test('an older core in a shared world ignores the slot: 0847c99f replays as it did with none', () => {
  const [a, b] = twoApart();
  const seedWord = worldSeedWord({ entry: a, roundRandomness: RAND, contract: shared, roundId: roundIdOf(shared), sharedWorld: [...game.sharedWorld] });
  const plain = replay(transcript, a, { core: { ...TRUCK_0847, runTicks: TICKS }, seedWord });
  const withWorld = replay(transcript, a, { core: core(shared, TRUCK_0847), roundRandomness: RAND });
  const other = replay(transcript, b, { core: core(shared, TRUCK_0847), roundRandomness: RAND });
  assert.equal(plain.ok && withWorld.ok && other.ok, true);
  assert.equal(withWorld.stateHash, plain.stateHash);
  assert.equal(other.stateHash, plain.stateHash, 'two entries of an old round start at one door, as they did');
});

test('a per-player round has no slot, and its run on the new core is the run with none', () => {
  const v3 = contractOf(TRUCK_V3_CONFIG_HASH);
  const e = entryOf(v3, session(1), b32(0x5e));
  assert.equal(slotOf(e, v3), undefined);
  const seedWord = seedWordForEntry(e, RAND);
  const page = (() => { const st = PAGE_CORE.init(seedWord | 0, { runTicks: TICKS }); for (let t = 0; t < TICKS; t++) PAGE_CORE.step(st, ...drive(t)); return PAGE_CORE.hash(st); })();
  const r = replay(transcript, e, { core: core(v3), roundRandomness: RAND });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.stateHash, page);
});
