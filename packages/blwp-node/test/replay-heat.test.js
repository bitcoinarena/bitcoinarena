// THE WAR HUNTS A REPLAY EXACTLY AS HARD AS IT HUNTED THE PLAYER.
//
// The ground was the first host-supplied world (letter 36), the collision
// boxes were the second (39), and this is the third and the smallest to write
// down: HOW HARD THE WAR HUNTS THE LOAD.
//
// `CargoBay.Heat` worked the wanted level out in floats on the Unity side and
// `BlwpSetHeat` wrote the answer straight into the page's own core. A host
// write is in no batch, no mark and no transcript, so the page's core carried
// 57229 and every replay of the same transcript carried 0 - and a ghost is a
// replay, which is why the other truck was drawn somewhere its driver had
// never been.
//
// Two things move: the LOAD crosses instead of the answer, and it crosses in
// the transcript. The core's own `rules/cargo.js` decides the cost, so there
// is one rule rather than a float copy that decided the game and an integer
// copy that had no caller at all.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { ghostForChecked } from '../src/ghosts.js';
import { init, step, submitLoad, heatOf } from '../../nextblock/src/sim.js';
import { heat as heatRule } from '../../nextblock/src/rules/cargo.js';
import { hash, O_TRUCK, T_X, T_Z } from '../../nextblock/src/state.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const ONE = 65536;
const M = (w) => (w / ONE).toFixed(3);
const b32 = (n) => new Uint8Array(32).fill(n);
// 1, not 7: with hold as the default (tank legs 12-20 s, posts held until the bound arrives; 4f9993e) seed 7's
// heat-blind replay ended only 0.84 m from the page at tick 900 (40.83 m before the cadence), too close to measure the
// fault. Seed 1 on the moving-ribbon core (44c72d7): the two part at tick 251 and are 28.946 m apart at 900, the loaded
// bed still reading 57229 (65.38 m at 900 when first measured, before the ribbon).
const SEED = 1;

// AN ORDINARY AUTO LOAD. What the page's core was HOLDING is the number that
// was measured - 57229 - and not the bed it came off, so the bed here is one
// that reads exactly that: 17,314 sats of fees and 0.42 BTC.
const FEE_SATS = 17314;
const BTC_HUND = 42;

const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** A drive that goes up the field and into the army's reach. */
const wordsAt = () => [45875, 6000, 0, 0, 0];

/** The player's own run: the load declared at roll-out, then the driving. */
function played(ticks, { fee = FEE_SATS, btc = BTC_HUND } = {}) {
  const st = init(SEED);
  submitLoad(st, fee, btc);
  for (let t = 0; t < ticks; t++) step(st, ...wordsAt(t));
  return st;
}

/** The same run through the daemon's door: batches in, transcript out. */
function stored(ticks, { fee = FEE_SATS, btc = BTC_HUND, chunk = 100, withLoad = true } = {}) {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const entry = entryFor(rid);
  const eid = r.enter(entry);

  let previousHash = GENESIS;
  const batches = [];
  for (let i = 0; i < ticks; i += chunk) {
    const n = Math.min(chunk, ticks - i);
    const rows = Array.from({ length: n }, (_, k) => wordsAt(i + k));
    const b = {
      roundId: rid, entryId: eid, previousHash, firstTick: i, ticks: rows,
      liquidations: [],
      // At the first tick of the run, which is where roll-out declares it.
      loads: (withLoad && i === 0) ? [[0, fee, btc]] : [],
    };
    assert.equal(r.batch(encodeInputBatch(b)), n, 'the node did not store every tick');
    previousHash = batchId(b);
    batches.push(b);
  }
  return { round: r, rid, eid, entry, batches, transcript: r.transcript(rid, eid) };
}

/**
 * THE NUMBER THE LETTER WAS OPENED ON, measured rather than quoted: what a
 * host-written heat was worth to a run nobody else could reproduce.
 */
test('a run hunted at 57229 and a replay hunted at zero are two different rounds', () => {
  const page = init(SEED);
  submitLoad(page, FEE_SATS, BTC_HUND);
  assert.equal(heatOf(page), 57229, 'the fixture bed does not read the heat that was measured');

  const blind = init(SEED);            // what every replay used to be
  assert.equal(heatOf(blind), 0);

  let first = null;
  const apart = [];
  for (let t = 1; t <= 900; t++) {
    step(page, ...wordsAt(t)); step(blind, ...wordsAt(t));
    const d = Math.hypot((page.i32[O_TRUCK + T_X] - blind.i32[O_TRUCK + T_X]) / ONE,
                         (page.i32[O_TRUCK + T_Z] - blind.i32[O_TRUCK + T_Z]) / ONE);
    if (first === null && d > 0) first = t;
    if (t % 300 === 0) apart.push(`tick ${t}: ${d.toFixed(3)} m`);
  }
  console.log(`  the page and a heat-blind replay part at tick ${first}`);
  console.log(`  ${apart.join(', ')}`);
  assert.ok(first !== null && first > 1, 'they parted at the first tick, so this measures something else');
  const last = Number(apart[apart.length - 1].split(': ')[1].replace(' m', ''));
  assert.ok(last > 5, `a heat-blind replay only ended up ${last} m out, so this measures nothing`);
  assert.notEqual(hash(page), hash(blind));
});

/**
 * AND THE FIX, THROUGH THE DAEMON'S OWN TABLES: the load is in the batch, the
 * node stores it, the transcript carries it and the replay reaches the state
 * the player reached.
 */
test('the load is in the transcript, so a replay reaches the player\'s own state', () => {
  const TICKS = 900;
  const run = played(TICKS);
  const { transcript, entry } = stored(TICKS);

  assert.equal(transcript.loads.length, 1, 'the node did not store the load');
  assert.deepEqual(transcript.loads[0], [0, FEE_SATS, BTC_HUND]);

  const got = replay(transcript, entry, { seedWord: SEED });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.loads, 1);
  assert.equal(got.heat, 57229, 'the replay was hunted at a different level');
  assert.equal(got.stateHash, hash(run), 'the replay reached a different state');
  console.log(`  player  (${M(run.i32[O_TRUCK + T_X])}, ${M(run.i32[O_TRUCK + T_Z])}) m at heat ${heatOf(run)}`);
  console.log(`  replay  the same state hash, at heat ${got.heat}`);

  // AND THE SAME RUN WITH THE LOAD LEFT OUT IS THE OLD FAULT, so the pass
  // above is the load and not a coincidence of this drive.
  const { transcript: blind, entry: e2 } = stored(TICKS, { withLoad: false });
  const without = replay(blind, e2, { seedWord: SEED });
  assert.equal(without.ok, true, without.why);
  assert.equal(without.loads, 0);
  assert.equal(without.heat, 0);
  assert.notEqual(without.stateHash, hash(run));
});

/**
 * AND THE GHOST, which is the whole of why letter 36 stayed open. A picture of
 * another player's truck is a replay, so a replay hunted at zero draws it
 * where nobody drove.
 */
test('the ghost of a loaded run is at the pose that run actually reached', () => {
  const TICKS = 900;
  const AT = 899;
  const run = played(TICKS);
  const { transcript, entry, rid, eid, batches } = stored(TICKS);

  const made = ghostForChecked({ core: TRUCK,
    transcript, entry, batches, roundId: rid, entryId: eid, tick: AT, seedWord: SEED,
  });
  assert.equal(made.ok, true, made.why);
  const drawn = Math.hypot((made.ghost.x - run.i32[O_TRUCK + T_X]) / ONE,
                           (made.ghost.z - run.i32[O_TRUCK + T_Z]) / ONE);
  console.log(`  drawn at (${M(made.ghost.x)}, ${M(made.ghost.z)}) m, `
    + `driven to (${M(run.i32[O_TRUCK + T_X])}, ${M(run.i32[O_TRUCK + T_Z])}) m: ${drawn.toFixed(3)} m apart`);
  assert.equal(drawn, 0, 'the ghost is not where that truck is');

  // The same tick off a transcript with no load in it - the picture every
  // watcher was being shown until this letter.
  const { transcript: blind, entry: e2, rid: r2, eid: i2, batches: b2 } = stored(TICKS, { withLoad: false });
  const old = ghostForChecked({ core: TRUCK,
    transcript: blind, entry: e2, batches: b2, roundId: r2, entryId: i2, tick: AT, seedWord: SEED,
  });
  assert.equal(old.ok, true, old.why);
  const wrong = Math.hypot((old.ghost.x - run.i32[O_TRUCK + T_X]) / ONE,
                           (old.ghost.z - run.i32[O_TRUCK + T_Z]) / ONE);
  console.log(`  without the load the same tick draws ${wrong.toFixed(3)} m away`);
  assert.ok(wrong > 5, 'a heat-blind ghost is not far enough out for this to be the fault');
});

/**
 * NO HOST DOOR LEFT, checked the way letters 36 and 39 are checked: by reading
 * the files a page actually runs.
 */
test('nothing writes a heat any more, and the browser bundle offers no way to', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const jslib = readFileSync(root + 'unity-proto/Assets/Plugins/WebGL/blwp.jslib', 'utf8');
  const cs = readFileSync(root + 'unity-proto/Assets/Scripts/Blwp/BlwpCore.cs', 'utf8');
  const bundle = readFileSync(root + 'packages/nextblock/dist/blwp-core.js', 'utf8');

  assert.equal(/BlwpSetHeat\s*:/.test(jslib), false, 'the bridge still exports a heat door');
  assert.equal(/bool\s+SetHeat\s*\(/.test(cs), false, 'BlwpCore still offers SetHeat');
  assert.match(jslib, /BlwpSubmitLoad\s*:/, 'the bridge has no way to declare a load');
  assert.match(jslib, /Module\.blwpNet\.load\(/, 'the bridge declares a load and never publishes it');

  // THE BUNDLE'S OWN LIST, which is what a page can reach. `setHeat`,
  // `setGround` and `setSolids` were all on it; all three were host doors into
  // the simulated world and none of them is now.
  const offered = bundle.slice(bundle.lastIndexOf('return { init: init'));
  for (const gone of ['setHeat', 'setGround', 'setSolids'])
    assert.equal(offered.includes(gone + ':'), false, `the browser bundle still offers ${gone}`);
  assert.ok(offered.includes('submitLoad:'), 'the browser bundle offers no way to declare a load');
  console.log('  host doors into the world on the browser bundle: 0');

  // AND NOTHING IN THE DAEMON SETS ONE EITHER, the same count replay-solids
  // keeps for the collision world.
  const src = readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /\bsetHeat\s*\(/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')));
  assert.deepEqual(src, [], 'something in src/ writes a heat rather than replaying a load');
});

/**
 * THE YARD'S PREVIEW GAUGE IS THE CORE'S RULE, pinned by its constants.
 *
 * `CargoBay.Heat` still exists and still draws the gauge the player watches
 * while they choose - there is no round to ask yet - but it decides nothing
 * once one starts. A second copy of a rule is how this project has been bitten
 * before, so the three numbers it is made of are held against the core's here,
 * where `node --test` can see them and Unity is not needed.
 */
test('the loadout gauge is made of the core\'s own constants', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const cs = readFileSync(root + 'unity-proto/Assets/Scripts/Cargo/CargoBay.cs', 'utf8');

  const at = (re, what) => {
    const m = cs.match(re);
    assert.ok(m, `CargoBay no longer says what ${what} is`);
    return Number(m[1]);
  };
  const atSats = at(/heatAtSats\s*=\s*([0-9.]+)f/, 'a full fee');
  const atBtc = at(/BtcCarried\s*\/\s*([0-9.]+)\)/, 'a full whale');
  const whale = at(/\*\s*([0-9.]+)f;\s*\n\s*return Mathf\.Clamp01\(fromFees/, 'the whale term');

  assert.equal(atSats, 20000, 'the gauge calls a load full at a different fee from the core');
  assert.equal(atBtc, 25, 'the gauge caps the whale term at a different value from the core');
  assert.equal(Math.round(whale * ONE), 29491, 'the whale term is not the core\'s 29491');

  // And the core agrees with those three, read back through the rule itself.
  assert.equal(heatRule(20000, 0), ONE);
  assert.equal(heatRule(0, 2500), 29491);
  assert.equal(heatRule(0, 250000), 29491);
  console.log(`  gauge: full at ${atSats} sats, whale caps at ${atBtc} BTC worth ${whale} - the core's own three`);
});
