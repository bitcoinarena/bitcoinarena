// EVERY READ OF `CoreDrivenTruck.seed` ON A LIVE ROUND, PRINTED.
//
// The constant is still in the player: `public int seed = 0x5eed1234`, read in
// two places - `Start` calls `BlwpCore.Init(seed)` before any round exists, and
// `StartRound` falls back to it when `BlwpNet.RoundSeed` is zero. A constant
// that can put this player's core back in the harness world is the whole of
// the 17:05 fault waiting to happen again, so the question is not whether it
// EXISTS but whether anything a live round does still reads it.
//
// Asked of the SHIPPED bridge rather than of the source: `blwp.jslib` is
// evaluated here the way Emscripten evaluates it, `$blwpDiscovery` included,
// and driven against two real daemons. Every call into the core's `init` is
// logged with the seed it was given, and every `record` is logged with the
// tick it carried, so the ORDER of the two is a measurement and not an
// argument about which line runs first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { joinFromQuery, tabIdentity, entryFor, fetchRandomness } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { spawnBay, bayZ } from '../../core/src/sim.js';
import { SOLO_SEED } from '../../core/src/rng.js';
import { O_TRUCK, T_Z } from '../../core/src/state.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const CLIENT = require('../dist/blwp-client.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const METRES = (w) => w / 65536;

/**
 * THE SHIPPED JSLIB, EVALUATED TWICE.
 *
 * `$blwpDiscovery` is an Emscripten library dependency: in a real build it
 * becomes a top-level function that `BlwpNetStart` calls by its bare name. The
 * first pass captures it off the object the file builds; the second binds it
 * so the SHIPPED discovery is the one that runs, rather than one written here.
 */
function shippedBridge(globals) {
  const src = readFileSync(
    new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  const names = Object.keys(globals);
  const load = (discovery) => {
    let lib = null;
    new Function('mergeInto', 'LibraryManager', 'blwpDiscovery', ...names, src)(
      (_t, obj) => { lib = obj; }, { library: {} }, discovery, ...names.map((n) => globals[n]));
    return lib;
  };
  const first = load(null);
  return load(first.$blwpDiscovery);
}

test('nothing on a live round reads the constant seed, and the core is in the round\'s world before a tick is recorded', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18220, portB: 18221 });
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const rid = roundId(named.round);
    const beacon = await fetchRandomness(toHex(rid), named.nodes);

    // A player whose own world is NOT the harness's, so a core that fell back
    // to the constant would be somewhere this test can see.
    let player, seat, entry, want;
    for (let tries = 0; ; tries++) {
      player = tabIdentity({ storage: storage(), random, curve: feldmanGroup });
      seat = entryFor(named.round, { playerPubkey: player.pubkey, random });
      entry = { ...seat, roundId: rid };
      want = seedWordForEntry({ ...entry, sessionPubkey: new Uint8Array(32) }, beacon.randomness);
      if (spawnBay(want) !== spawnBay(SOLO_SEED)) break;
      assert.ok(tries < 200, '200 identities all parked on the harness bay, which is not chance');
    }

    // WHAT THE CORE IS ASKED TO BE, every time, with the seed it was given.
    const inits = [];
    const wrapped = {
      ...core,
      init: (s) => { inits.push({ seed: s >>> 0, at: Date.now() }); return core.init(s); },
    };

    // AND EVERY TICK THE CLIENT IS ASKED TO KEEP.
    const records = [];
    const realRecord = CLIENT.Client.prototype.record;
    CLIENT.Client.prototype.record = function (words) {
      records.push({ initsSoFar: inits.length });
      return realRecord.call(this, words);
    };

    const heap = new Int32Array(64);
    const Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
    let library;
    try {
      library = shippedBridge({
        Module,
        HEAP32: heap,
        UTF8ToString: () => named.nodes[0],
        window: { location: { search: new URL(round.url).search } },
        console,
        crypto,
        BLWP: wrapped,
        BLWPCLIENT: CLIENT,
        BLWP_CURVE: pageCurve,
        BLWP_ROUND: named.round,
        BLWP_ENTRY: seat,
        BLWP_NODES: named.nodes,
        BLWP_CHAIN: named.chain,
        BLWP_ADVERT: named.advert,
      });

      // ---- WHAT C# DOES, IN ITS ORDER. ----
      //
      // `CoreDrivenTruck.Start` runs at scene start, before any round is
      // joined, and it passes the constant. That is READ SITE ONE and this
      // makes it happen rather than assuming it away.
      assert.equal(library.BlwpInit(SOLO_SEED), 1, 'the core did not come up');
      assert.equal(inits.length, 1);
      assert.equal(inits[0].seed, SOLO_SEED >>> 0, 'the first init was not the constant');

      // The truck steps while the page is still joining - a player sitting in
      // the bay - and NOTHING may be recorded out of the constant world.
      for (let t = 0; t < 30; t++) library.BlwpStep(45875, 0, 0, 0, 0);
      assert.equal(records.length, 0,
        'a tick was recorded before the round\'s world existed');

      // ---- AND THEN THE PAGE JOINS. ----
      assert.equal(library.BlwpNetStart(0, 6, 60), 1, 'the bridge would not start');
      for (let i = 0; i < 200 && !Module.blwpNet.client; i++) await wait(50);
      assert.ok(Module.blwpNet.client, `the session never opened: ${Module.blwpNet.error}`);

      // ---- WHAT WAS READ, PRINTED. ----
      console.log('');
      console.log('  every init the shipped bridge asked the core for, in order:');
      for (let i = 0; i < inits.length; i++) {
        const s = inits[i].seed;
        console.log(`    ${i + 1}. 0x${s.toString(16)}  bay ${spawnBay(s)}  `
          + `z ${METRES(bayZ(spawnBay(s))).toFixed(2)} m`
          + (s === (SOLO_SEED >>> 0) ? '   <- CoreDrivenTruck.seed, the constant' : '   <- the round'));
      }
      console.log(`  ticks recorded before the round's init: ${
        records.filter((r) => r.initsSoFar < 2).length}`);
      console.log(`  BlwpRoundSeed() answers 0x${(library.BlwpRoundSeed() >>> 0).toString(16)}`);

      // THE CORE IS IN THE COMMITTEE'S WORLD, and it is the state the next
      // tick will step - not a second core kept beside it.
      assert.equal(inits.length, 2, 'the bridge did not put the core in the round\'s world');
      assert.equal(inits[1].seed, want >>> 0,
        'the bridge seeded a world the committee will not replay this entry in');
      assert.notEqual(inits[1].seed, SOLO_SEED >>> 0);
      assert.equal(Module.blwp.st.i32[O_TRUCK + T_Z], bayZ(spawnBay(want)),
        'the core the page will step is not standing where this round parks this player');

      // ---- AND NOW IT DRIVES. ----
      const before = records.length;
      for (let t = 0; t < 30; t++) library.BlwpStep(45875, 22000, 0, 0, 0);
      assert.ok(records.length > before, 'the bridge recorded nothing after joining');
      assert.equal(records.filter((r) => r.initsSoFar < 2).length, 0,
        'a tick was recorded while the core was still in the constant world');
      assert.equal(inits.length, 2, 'the core was re-seeded again after ticks were recorded');

      // READ SITE TWO: `StartRound` takes `BlwpNet.RoundSeed` and only falls
      // back to the constant when it is zero. On a live round it is not.
      assert.equal(library.BlwpRoundSeed() >>> 0, want >>> 0,
        'C# would restart this round\'s core into a world nobody replays');
      assert.notEqual(library.BlwpRoundSeed(), 0);
    } finally {
      CLIENT.Client.prototype.record = realRecord;
      try { Module.blwpNet && Module.blwpNet.client && Module.blwpNet.client.close(); } catch { /* gone */ }
    }
  } finally { await round.close(); }
});

/**
 * AND WITH NO ROUND, THE CONSTANT IS THE ANSWER AND MUST BE.
 *
 * `BlwpRoundSeed` is 0 when there is no session, which is what keeps the
 * single-player daily on the solo apron - bay 13, the harness seed, the world
 * the golden vectors were measured in.
 */
test('with no round the bridge names no seed, which is what holds the daily on bay 13', () => {
  const heap = new Int32Array(64);
  const Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
  const library = shippedBridge({
    Module, HEAP32: heap, UTF8ToString: () => '', window: { location: { search: '' } },
    console, crypto, BLWP: core, BLWPCLIENT: CLIENT,
  });
  assert.equal(library.BlwpRoundSeed(), 0, 'a page with no round named a round seed');
  assert.equal(spawnBay(SOLO_SEED), 13, 'the harness seed left the solo bay');
});

/**
 * AND WHAT A ROLL-OUT DOES TO A TRANSCRIPT THAT IS ALREADY RUNNING.
 *
 * `LoadoutPanel` calls `CoreDrivenTruck.StartRound` when the bay shuts, and
 * that calls `BlwpCore.Restart(world)` - the core's own `init` again. On the
 * single-player daily that is the point: one core, many rounds, and the score
 * card is read before the next one starts. On a LIVE round there is one run,
 * it began when the page was seeded, and the client has been recording since
 * the join - the 16:08 report saw tick 4241 while the truck was still in the
 * bay. So this asks the core what a restart in the middle costs, in the only
 * terms that matter: the state hash the player marks against the state hash a
 * committee reaches by replaying the ticks the player published.
 */
test('a restart in the middle of a live run is not the run the committee replays', () => {
  const seed = 0x0ae8bebb;
  const words = [45875, 22000, 0, 0, 0];

  // WHAT THE PLAYER PUBLISHES: sixty ticks, a roll-out, sixty more. Every one
  // of them is recorded - `BlwpStep` hands them over whatever the game is
  // doing - so the transcript is one hundred and twenty ticks long.
  const page = core.init(seed);
  for (let t = 0; t < 60; t++) core.step(page, ...words);
  const rolled = core.restart(page, seed);            // what StartRound does
  for (let t = 0; t < 60; t++) core.step(rolled, ...words);

  // WHAT THE COMMITTEE REACHES: the same one hundred and twenty ticks, from
  // the same seed, with nothing in the middle.
  const replay = core.init(seed);
  for (let t = 0; t < 120; t++) core.step(replay, ...words);

  const mine = core.hash(rolled);
  const theirs = core.hash(replay);
  console.log(`  after 120 published ticks with a roll-out at 60:`);
  console.log(`    the page holds   ${mine}`);
  console.log(`    the committee    ${theirs}`);
  console.log(`    z: page ${(rolled.i32[O_TRUCK + T_Z] / 65536).toFixed(3)} m, `
    + `committee ${(replay.i32[O_TRUCK + T_Z] / 65536).toFixed(3)} m`);
  assert.notEqual(mine, theirs,
    'a restart in the middle cost nothing, so this hazard is not one');
});
