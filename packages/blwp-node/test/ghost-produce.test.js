// WHERE THE THREE NUMBERS COME FROM.
//
// Piece 1 of this letter put the GHOSTS frame on the wire and piece 3 decided
// who gets one; measured before this file, nothing in `blwp-node/src` or
// `blwp-client/src` called `encodeGhost` at all. So the frame could be checked
// and could not be MADE, and the interesting half is the making: a node that
// invents coordinates paints a competitor somewhere they never were, and
// `ghostBinds` says out loud that it cannot catch that - "this cannot say the
// truck was AT x,z - only a replay says that".
//
// So a picture is a replay of what the other player published, through
// `replay.js`, the one door. This file is the number that closes slice 1: the
// same three words, from the core driven directly and from the daemon's
// tables, at the same tick.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { ghostFor, ghostForChecked } from '../src/ghosts.js';
import { TRUCK } from '../src/cores.js';
import { init, step, submitLiquidation } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../core/src/state.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { decodeGhost, ghostBinds, GHOST_BYTES } from '../../protocol/src/ghost.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

// The fixture owns this seed exactly as `replay.test.js` owns its 7: nothing
// here says a round's seed is 7.
const SEED = 7;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const LIQUIDATIONS = [[37, 3 * 65536]];
const TICKS = 300;
const CHUNK = 100;

/** The player's own run, driven straight off the core. */
function played(ticks, { from = 0 } = {}) {
  const due = new Map(LIQUIDATIONS);
  const st = init(SEED);
  const truck = new Map();
  for (let i = 0; i < ticks; i++) {
    const at = from + i;
    if (due.has(at)) submitLiquidation(st, due.get(at));
    step(st, ...wordsAt(at));
    truck.set(at, {
      x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING],
    });
  }
  return truck;
}

/** The same run through the daemon's door, with the batches kept. */
function stored(ticks, { from = 0, chunk = CHUNK } = {}) {
  const r = new Round(openStore(), () => 1234);
  const rid = r.open(contract());
  const entry = entryFor(rid, from);
  const eid = r.enter(entry);

  const due = new Map(LIQUIDATIONS);
  const batches = [];
  let previousHash = GENESIS;
  for (let i = 0; i < ticks; i += chunk) {
    const n = Math.min(chunk, ticks - i);
    const first = from + i;
    const rows = [];
    for (let k = 0; k < n; k++) rows.push(wordsAt(first + k));
    const b = {
      roundId: rid, entryId: eid, previousHash, firstTick: first, ticks: rows,
      liquidations: [...due].filter(([at]) => at >= first && at < first + n),
    };
    assert.equal(r.batch(encodeInputBatch(b)), n, 'the node did not store every tick');
    batches.push(b);
    previousHash = batchId(b);
  }
  return {
    round: r, rid, eid, entry, batches,
    transcript: r.transcript(rid, eid),
    make: (tick, over = {}) => ghostForChecked({ core: TRUCK,
      transcript: r.transcript(rid, eid), entry, batches, roundId: rid, entryId: eid,
      tick, seedWord: SEED, ...over,
    }),
  };
}

/**
 * THE NUMBER: a picture is the core's own truck at that tick.
 */
test('a produced ghost carries the truck the core reached at that tick', () => {
  const truck = played(TICKS);
  const run = stored(TICKS);

  for (const tick of [0, 1, 37, 99, 100, 250, TICKS - 1]) {
    const made = run.make(tick);
    assert.equal(made.ok, true, `${tick}: ${made.why}`);
    const g = decodeGhost(made.bytes);

    assert.equal(g.tick, tick);
    assert.equal(g.x, truck.get(tick).x, `tick ${tick}: x is not the core's`);
    assert.equal(g.z, truck.get(tick).z, `tick ${tick}: z is not the core's`);
    assert.equal(g.heading, truck.get(tick).heading, `tick ${tick}: heading is not the core's`);

  }

  // AND THE FIXTURE MOVES, or every equality above is a truck sitting still
  // and the test proves nothing. Measured rather than assumed: the run starts
  // at rest, so the first few ticks really are identical, and the check that
  // an off-by-one would be CAUGHT belongs at a tick where the truck is
  // driving.
  assert.notEqual(truck.get(TICKS - 1).x, truck.get(0).x, 'this run never moved');
  for (const tick of [99, 150, 250]) {
    assert.notEqual(truck.get(tick).x, truck.get(tick + 1).x,
      `at tick ${tick} the truck is still, so a picture taken one tick late would look right`);
  }
});

test('a produced ghost binds against the transcript it came from', () => {
  const run = stored(TICKS);
  const made = run.make(150);
  assert.equal(made.ok, true, made.why);
  assert.equal(made.bytes.length, GHOST_BYTES);

  const g = decodeGhost(made.bytes);
  const bound = ghostBinds(g, { roundId: run.rid, entryId: run.eid, batches: run.batches }, run.entry);
  assert.equal(bound.ok, true, bound.why);
  assert.equal(bound.unchecked.length, 0, 'the entry was offered, so nothing should be unchecked');

  // the head it names is the one that COVERS that tick, not a later one that
  // would also pass: the picture came from those inputs
  assert.deepEqual(toHex(g.inputChainHash), toHex(batchId(run.batches[1])));
  assert.deepEqual(g.playerPubkey, run.entry.playerPubkey);
  assert.notDeepEqual(toHex(g.inputChainHash), toHex(GENESIS));
});

test('a tick the published inputs do not cover produces no picture', () => {
  const run = stored(TICKS);

  const past = run.make(TICKS);
  assert.equal(past.ok, false, 'a picture was taken of a tick nobody published inputs for');
  assert.match(past.why, /not one the published inputs cover/);

  assert.match(run.make(TICKS + 5000).why, /not one the published inputs cover/);
  assert.match(run.make(-1).why, /a ghost is at a whole tick/);

  // AND THE SAME REFUSAL FROM THE OTHER END. `ghostBinds` is what a stranger
  // runs, so a frame this file would not build is also one nobody would
  // accept - the two ends agree instead of one cleaning up after the other.
  const good = run.make(150);
  const late = { ...decodeGhost(good.bytes), tick: TICKS };
  assert.match(ghostBinds(late, { roundId: run.rid, entryId: run.eid, batches: run.batches }, run.entry).why,
    /the inputs it names cover/);
});

test('a head the chain never reached is refused, genesis included', () => {
  const run = stored(TICKS);
  const good = decodeGhost(run.make(150).bytes);

  const stranger = { ...good, inputChainHash: b32(0x9c) };
  assert.match(ghostBinds(stranger, { roundId: run.rid, entryId: run.eid, batches: run.batches }, run.entry).why,
    /so that picture was taken from inputs nobody published/);

  const fromNothing = { ...good, inputChainHash: GENESIS };
  assert.match(ghostBinds(fromNothing, { roundId: run.rid, entryId: run.eid, batches: run.batches }, run.entry).why,
    /taken before any input went out/);

  // and a broken chain never gets as far as a replay
  const broken = run.make(150, { batches: [run.batches[0], { ...run.batches[2] }] });
  assert.equal(broken.ok, false);
  assert.match(broken.why, /input chain is broken/);
});

test('a run with no published inputs produces no picture', () => {
  const r = new Round(openStore(), () => 1234);
  const rid = r.open(contract());
  const entry = entryFor(rid, 0);
  const eid = r.enter(entry);

  // an entry that has entered and never published a batch
  const none = ghostFor({ core: TRUCK,
    transcript: r.transcript(rid, eid), entry, batches: [], roundId: rid, entryId: eid,
    tick: 0, seedWord: SEED,
  });
  assert.equal(none.ok, false, 'a truck was painted for a run that never went out');
  assert.match(none.why, /published no inputs/);

  // and a chain of empty batches is the same answer: there is no tick to be a
  // picture of, and the refusal says that rather than "no such tick"
  const empty = ghostFor({ core: TRUCK,
    transcript: r.transcript(rid, eid), entry, roundId: rid, entryId: eid, tick: 0, seedWord: SEED,
    batches: [{ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [], liquidations: [] }],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.why, /published no inputs/);
});

test('a late entry is photographed at the ticks it actually played', () => {
  const FROM = 500;
  const truck = played(TICKS, { from: FROM });
  const run = stored(TICKS, { from: FROM });

  const made = run.make(FROM + 10);
  assert.equal(made.ok, true, made.why);
  const g = decodeGhost(made.bytes);
  assert.equal(g.x, truck.get(FROM + 10).x, 'a late run was replayed from the wrong tick');

  // and tick 0 is not this player's run at all: 19 says a late run begins at
  // the tick its own entry names
  assert.equal(run.make(0).ok, false);
  assert.match(run.make(0).why, /not one the published inputs cover/);
});
