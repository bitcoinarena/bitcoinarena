// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OBJECTION DOES NOT WAIT BEHIND A RUN NOBODY DISPUTED.
//
// Section 13A gives an objection a window. A pool that served whatever arrived
// first could be pushed past the end of that window by a flood of undisputed
// runs, and a veto that expires unheard is a veto that was never there. So the
// order is a rule, not a queue discipline anyone may tune.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { ReplayPool, classOf, OBJECTED, RANKED, REST } from '../src/pool.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
import { init, step, submitLiquidation } from '../../nextblock/src/sim.js';
import { hash } from '../../nextblock/src/state.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick,
  // the owner put the world secret on the Entry Contract (e942580) so a node can
  // derive the world it replays. These fixtures still hand `replay` a
  // `seedWord` directly, which is the fixture owning its own number; what the
  // entry carries here is only what the encoder now requires.
  worldSecret: b32(0x5c), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** The fixture's own number, the way the client's checkpoint test owns its 7. */
const SEED = 7;
const LIQ = [[37, 3 * 65536]];
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

function played(ticks, { from = 0 } = {}) {
  const due = new Map(LIQ);
  const st = init(SEED);
  const marks = [];
  for (let i = 0; i < ticks; i++) {
    const at = from + i;
    if (due.has(at)) submitLiquidation(st, due.get(at));
    step(st, ...wordsAt(at));
    if ((at + 1) % 60 === 0) marks.push({ tick: at + 1, stateHash: hash(st) });
  }
  return { marks, stateHash: hash(st) };
}

function stored(ticks, { from = 0 } = {}) {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const entry = entryFor(rid, from);
  const eid = r.enter(entry);
  const rows = [];
  for (let k = 0; k < ticks; k++) rows.push(wordsAt(from + k));
  const b = {
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: from,
    ticks: rows, liquidations: [...LIQ].filter(([at]) => at >= from && at < from + ticks),
  };
  assert.equal(r.batch(encodeInputBatch(b)), ticks);
  void batchId(b);
  return { entry, transcript: r.transcript(rid, eid) };
}

/**
 * THE CLASSES ARE THE SPEC'S THREE, and none of them is computed here: an
 * objection is a fact the node holds, and a rank is the board's from letter 20.
 */
test('a job is objected, ranked, or the rest, and the pool decides none of it', () => {
  assert.equal(classOf({ objected: true }), OBJECTED);
  assert.equal(classOf({ objected: true, rank: 1 }), OBJECTED, 'a rank outranked an objection');
  assert.equal(classOf({ rank: 1 }), RANKED);
  assert.equal(classOf({ rank: 0 }), RANKED, 'rank 0 was read as no rank at all');
  assert.equal(classOf({}), REST);
  assert.equal(classOf({ rank: null }), REST);
  assert.throws(() => new ReplayPool({ workers: 0 }), /at least one/);
});

/**
 * THE MEASUREMENT THAT MATTERS: with the pool busy, an objection submitted
 * AFTER two undisputed runs still goes before them.
 */
test('an objected run leaves the queue while unobjected runs sit', async () => {
  const TICKS = 120;
  const run = played(TICKS);
  const s = stored(TICKS);
  const pool = new ReplayPool({ workers: 1 });
  const job = (key, extra) => ({
    core: TRUCK, key, transcript: s.transcript, entry: s.entry,
    options: { seedWord: SEED, marks: run.marks }, ...extra,
  });

  // The first job takes the only worker. Everything after it queues.
  const first = pool.submit(job('busy'));
  const plainA = pool.submit(job('plain-a'));
  const ranked = pool.submit(job('ranked', { rank: 3 }));
  const plainB = pool.submit(job('plain-b'));
  const objected = pool.submit(job('objected', { objected: true }));

  const answers = await Promise.all([first, plainA, ranked, plainB, objected]);

  assert.deepEqual(pool.order, ['busy', 'objected', 'ranked', 'plain-a', 'plain-b'],
    'the pool served a run nobody disputed while an objection waited');
  assert.equal(pool.waiting, 0);

  // AND THE VERDICTS ARE UNTOUCHED: the pool decides when, never what.
  for (const a of answers) {
    assert.equal(a.ok, true, a.why);
    assert.equal(a.stateHash, run.stateHash, 'a queued replay reached a different state');
    assert.equal(a.checked, run.marks.length);
    assert.equal(a.agrees, true);
  }
});

/**
 * AND IT CANNOT BE STARVED BY A FLOOD. Ten undisputed runs are already queued
 * when one objection arrives; the objection is next out, not eleventh.
 */
test('an objection arriving last is served next, whatever is queued ahead of it', async () => {
  const TICKS = 60;
  const run = played(TICKS);
  const s = stored(TICKS);
  const pool = new ReplayPool({ workers: 1 });
  const job = (key, extra) => ({
    core: TRUCK, key, transcript: s.transcript, entry: s.entry, options: { seedWord: SEED }, ...extra,
  });

  const all = [pool.submit(job('busy'))];
  for (let i = 0; i < 10; i++) all.push(pool.submit(job(`flood-${i}`)));
  all.push(pool.submit(job('late-objection', { objected: true })));
  await Promise.all(all);

  assert.equal(pool.order[0], 'busy');
  assert.equal(pool.order[1], 'late-objection',
    `ten undisputed runs pushed the objection to position ${pool.order.indexOf('late-objection')}`);
  assert.equal(pool.order.length, 12);
  assert.equal(new Set(pool.order).size, 12, 'a job was started twice');
});

/**
 * THE POOL CHANGES NOTHING ABOUT A REPLAY: same hash, same refusal shape, and
 * a late joiner still starts at the tick its own entry names.
 */
test('through the pool: same hashes, same refusal, and a late run starts at its own tick', async () => {
  const TICKS = 120, FROM = 50;
  const straight = played(TICKS);
  const late = played(TICKS, { from: FROM });
  const s0 = stored(TICKS);
  const s50 = stored(TICKS, { from: FROM });

  const pool = new ReplayPool({ workers: 2 });
  const [a, b] = await Promise.all([
    pool.submit({ core: TRUCK, key: 'from-0', transcript: s0.transcript, entry: s0.entry,
      options: { seedWord: SEED, marks: straight.marks } }),
    pool.submit({ core: TRUCK, key: 'from-50', transcript: s50.transcript, entry: s50.entry,
      options: { seedWord: SEED, marks: late.marks } }),
  ]);

  assert.equal(a.stateHash, straight.stateHash);
  assert.equal(b.stateHash, late.stateHash);
  assert.notEqual(a.stateHash, b.stateHash, 'the two runs are the same, so the fixture proves nothing');
  assert.equal(b.agrees, true, 'the late run was replayed from the wrong tick');

  // THE REFUSAL SHAPE SURVIVES THE QUEUE. A run whose world cannot be derived
  // is refused with the reason, and the pool does not paper over it: the seed
  // now comes from the entry's own secret and the round's randomness, and the
  // randomness is a future Bitcoin block hash no node here draws.
  const refused = await pool.submit({ core: TRUCK, key: 'no-seed', transcript: s0.transcript, entry: s0.entry });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /names no randomness to mix the player seed/);

  assert.throws(() => pool.submit({ transcript: s0.transcript }), /needs a key/);
});
