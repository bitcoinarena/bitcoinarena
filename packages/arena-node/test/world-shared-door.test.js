// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AT THE SEATS (2026-10-04: "the player chooses nothing about the world"): a shared-world round (config v4 of
// core 7e2123d1) takes an entry only with a world secret of 32 zero bytes, and the seats' replay derives the round's one
// world - the same seed word the page's join computes (seed.js worldSeedWord) - for every player, whatever key he brings;
// a per-player round (v3, f51759b6) keeps each player's own. Fixtures from run-length.test.js.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH as TRUCK_CONFIG_HASH, TRUCK_SHARED_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { TRUCK_BEFORE_FORK_HASH } from '../../nextblock/plugin/nextblock.js';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
import { fromHex as fromHexForFork } from '../../arena-protocol/src/hash.js';
import { Round } from '../src/round.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { lastTickOfRun, runTicksForEntry, runLengthIsTheCores } from '../../arena-protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contractWith = (blockTicks) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
});
const entryOn = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const words = () => [45875, 0, 0, 0, 0];
import { worldSeedWord } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { hostedPlugins } from '../src/plugins.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const shared = () => ({ ...contractWith(BLOCK_TICKS), configHash: TRUCK_SHARED_CONFIG_HASH });
const zero = new Uint8Array(32);

test('a shared-world round takes an entry with a zero world secret and refuses one with a secret of its own', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000, { plugins: HOSTED });
  const rid = round.open(shared());
  assert.ok(round.enter({ ...entryOn(rid), worldSecret: zero }));
  assert.throws(() => round.enter({ ...entryOn(rid), playerPubkey: b32(0x66), worldSecret: b32(0x5e) }),
    /shares one world among its players: an entry names no world secret/);
  // a per-player round (v3) takes a secret as before
  const per = new Round(openStore(':memory:'), () => NOW + 1000, { plugins: HOSTED });
  assert.ok(per.enter(entryOn(per.open(contractWith(BLOCK_TICKS)))));
});

// THE SEATS DERIVE THE PAGE'S WORLD: a run replayed with the round's world rule carried on the core (as ghosts.js and
// verify.js resolve it) is the run replayed with the seed word the page computes - and two players of the round, with
// different keys, are pictured in the same world; under v3 their worlds part.
test('the seats\' replay of a shared-world round derives the page\'s seed word, the same for every player', () => {
  const RAND = b32(0xbe);
  const ticks = []; for (let t = 0; t < 120; t++) ticks.push({ tick: t, words: words() });
  const pics = (contract, e, opts) => {
    const r = replay({ ticks, liquidations: [] }, e, { roundRandomness: RAND, pictures: [0, 119], ...opts });
    assert.equal(r.ok, true, r.why);
    return JSON.stringify(r.pictures);
  };
  // AS GHOSTS.JS AND VERIFY.JS RESOLVE IT: with the round's game's shared-world configs (the game says)
  const game = hostedPlugins(HOSTED).get(toHex(NEXTBLOCK_GAME_ID));
  const world = (contract) => ({ configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: roundIdOf(contract),
    sharedWorld: [...game.sharedWorld] });
  const c4 = shared(); const c3 = contractWith(BLOCK_TICKS);
  const alice = { ...entryOn(roundIdOf(c4)), worldSecret: zero, playerPubkey: b32(0x0a) };
  const bob = { ...entryOn(roundIdOf(c4)), worldSecret: zero, playerPubkey: b32(0x0b) };
  const byRule = pics(c4, alice, { core: { ...TRUCK, world: world(c4) } });
  const byPage = pics(c4, alice, { seedWord: worldSeedWord({ entry: alice, roundRandomness: RAND, contract: c4, roundId: roundIdOf(c4), sharedWorld: sharedWorldOf(c4.gameId) }) });
  assert.equal(byRule, byPage, 'the seats replayed another world than the page joined');
  assert.equal(pics(c4, bob, { core: { ...TRUCK, world: world(c4) } }), byRule, 'two players of one shared round drove two worlds');
  const a3 = { ...alice, roundId: roundIdOf(c3), worldSecret: b32(0x5e) }; const b3 = { ...bob, roundId: roundIdOf(c3), worldSecret: b32(0x5f) };
  assert.notEqual(pics(c3, a3, { core: { ...TRUCK, world: world(c3) } }), pics(c3, b3, { core: { ...TRUCK, world: world(c3) } }),
    'a per-player round (v3) shared its world');
});
