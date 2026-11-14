// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit r1-play-1: a batch's LIQUIDATIONS are the player's own word. The input door checks a batch's
// prices against the committee's attestation (§11, checkBatchPrices) and its load against the bed rules (#1488), but a
// `liquidations` vector is taken as sent: any tick, any size up to LIQ_MAX, one per tick. In the truck core each one is a
// nuke at the densest knot of tanks near the front - every unit in the crater dies - so a modified client that declares
// a strike whenever the war closes in on its truck replays (at every seat, deterministically) as a run the war never
// touched. SAFE: on a seat that runs the committee's feed for the round (pricesRequired), a liquidation the committee
// did not attest is refused like a bare price sample is; the player never chooses the market events of its own run.
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
import { LIQ_MAX } from '../../nextblock/src/state.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

// the core's verdict on one run: the vector's inputs, with the liquidations a client chose
const replay = (v, liquidations) => {
  const st = CORE.start(v.seed, null, {});
  const ev = CORE.eventsOf({ liquidations });
  let res = null;
  for (let t = 0; t < v.ticks; t++) {
    ev.before(st, t);
    CORE.step(st, v.inputs[t]);
    res = CORE.result(st);
    if (res.outcome) return { tick: t + 1, ...res };
  }
  return { tick: v.ticks, ...res };
};

test('wf1489-r1-play-1: a declared liquidation changes what the run comes to (evidence)', () => {
  const DIR = new URL('../../nextblock/test-vectors/', import.meta.url).pathname;
  const seen = [];
  for (const name of ['straight', 'slalom', 'liquidation', 'idle']) {
    const v = JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
    const honest = replay(v, v.liquidations || []);
    const forged = replay(v, Array.from({ length: Math.floor(v.ticks / 30) }, (_, i) => [i * 30 + 1, LIQ_MAX]));
    console.log(`[r1-play-1] ${name}: honest ${JSON.stringify(honest)} | a nuke every 30 ticks ${JSON.stringify(forged)}`);
    seen.push(JSON.stringify(honest) !== JSON.stringify(forged));
  }
  assert.ok(seen.some(Boolean), 'the player-declared strikes decide the replayed run');
});

test('wf1489-r1-play-1: a seat running the committee feed refuses a liquidation the committee did not attest', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const sks = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x40 + n));
  const seats = sks.map((sk) => schnorr.getPublicKey(sk));
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  r.pricesRequired = () => true;                       // this seat runs the committee's feed: a bare price is refused
  const rid = r.open(contract(seats)); const eid = r.enter(entryFor(rid));
  const w = [65536, 0, 0, 0, 0];
  // a bare price sample is refused here (the existing rule) ...
  assert.throws(() => r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [w], liquidations: [], samples: [[0, 123456]] })),
    /without the committee's attestation/);
  // ... and a strike at the maximum size, chosen by the client, at a tick of its choosing, must be refused the same way
  let took = null; let why = null;
  try {
    took = r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 30 }, () => w), liquidations: [[1, LIQ_MAX], [2, LIQ_MAX]].slice(0, 1).concat([[11, LIQ_MAX], [21, LIQ_MAX]]) }));
  } catch (e) { why = e.message; }
  console.log(`[r1-play-1] unattested liquidations at LIQ_MAX: took=${took} why=${why} stored=${JSON.stringify(r.transcript(rid, eid).liquidations)}`);
  assert.equal(took, null, 'a batch carrying liquidations nobody attested is not stored as the player\'s run');
  assert.deepEqual(r.transcript(rid, eid).liquidations, [], 'no player-chosen strike is in the transcript the seats replay');
});
