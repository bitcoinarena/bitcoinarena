// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY READ OF `CoreDrivenTruck.seed` ON A LIVE ROUND, PRINTED.
//
// The constant is still in the player: `public int seed = 0x5eed1234`, read in
// two places - `Start` calls `ArenaCore.Init(seed)` before any round exists, and
// `StartRound` falls back to it when `ArenaNet.RoundSeed` is zero. A constant
// that can put this player's core back in the harness world is the whole of
// the 17:05 fault waiting to happen again, so the question is not whether it
// EXISTS but whether anything a live round does still reads it.
//
// Asked of the SHIPPED bridge rather than of the source: `arena.jslib` is
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

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
//: these are about PER-PLAYER worlds (the bridge must not fall back to the harness seed), so their rounds name the
// per-player config v3; the shared world (v4) is world-shared.test.js and world-shared-door.test.js.
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { joinFromQuery, tabSeed, playerFor, entryFor, fetchRandomness } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { spawnBay, bayZ } from '../../nextblock/src/sim.js';
import { SOLO_SEED } from '../../nextblock/src/rng.js';
import { O_TRUCK, T_Z } from '../../nextblock/src/state.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const CLIENT = require('../dist/arena-client.js');
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
 * becomes a top-level function that `ArenaNetStart` calls by its bare name. The
 * first pass captures it off the object the file builds; the second binds it
 * so the SHIPPED discovery is the one that runs, rather than one written here.
 */
function shippedBridge(globals) {
  const src = readFileSync(
    new URL('../../../unity-proto/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  const names = Object.keys(globals);
  // EVERY `$`-PREFIXED MEMBER, not just the one this file happened to need.
  // Emscripten turns each into a top-level function that the exported ones
  // call by its bare name, so a helper added to the bridge would otherwise be
  // a ReferenceError here and nowhere else - which is a test that stops
  // testing the shipped file the moment somebody adds one.
  const load = (helpers) => {
    let lib = null;
    const hn = Object.keys(helpers);
    new Function('mergeInto', 'LibraryManager', ...hn, ...names, src)(
      (_t, obj) => { lib = obj; }, { library: {} },
      ...hn.map((n) => helpers[n]), ...names.map((n) => globals[n]));
    return lib;
  };
  const first = load({});
  const helpers = {};
  for (const k of Object.keys(first)) if (k.startsWith('$')) helpers[k.slice(1)] = first[k];
  return load(helpers);
}

test('nothing on a live round reads the constant seed, and the core is in the round\'s world before a tick is recorded', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18220, portB: 18221, configHash: TRUCK_V3_CONFIG_HASH });
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const rid = roundId(named.round);
    const beacon = await fetchRandomness(toHex(rid), named.nodes);

    // A player whose own world is NOT the harness's, so a core that fell back
    // to the constant would be somewhere this test can see.
    let player, signerNode, entry, want;
    for (let tries = 0; ; tries++) {
      player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
      entry = { ...signerNode, roundId: rid };
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
        BLWP_ENTRY: signerNode,
        BLWP_NODES: named.nodes,
        BLWP_CHAIN: named.chain,
        BLWP_ADVERT: named.advert,
      });

      // ---- WHAT C# DOES, IN ITS ORDER. ----
      //
      // `CoreDrivenTruck.Start` runs at scene start, before any round is
      // joined, and it passes the constant. That is READ SITE ONE and this
      // makes it happen rather than assuming it away.
      assert.equal(library.ArenaInit(SOLO_SEED), 1, 'the core did not come up');
      assert.equal(inits.length, 1);
      assert.equal(inits[0].seed, SOLO_SEED >>> 0, 'the first init was not the constant');

      // The truck steps while the page is still joining - a player sitting in
      // the bay - and NOTHING may be recorded out of the constant world.
      for (let t = 0; t < 30; t++) library.ArenaStep(45875, 0, 0, 0, 0);
      assert.equal(records.length, 0,
        'a tick was recorded before the round\'s world existed');

      // ---- AND THEN THE PAGE JOINS. ----
      assert.equal(library.ArenaNetStart(0, 6, 60), 1, 'the bridge would not start');
      // UNTIL RECORDING BEGINS, not until the client exists: the round's world
      // is entered in the same step that starts recording (the 16/24-tick
      // gap, 2026-09-10), so a client that exists has not yet been put there.
      for (let i = 0; i < 200 && !(Module.arenaNet.client && Module.arenaNet.client.where); i++) await wait(50);
      assert.ok(Module.arenaNet.client, `the session never opened: ${Module.arenaNet.error}`);

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
      console.log(`  ArenaRoundSeed() answers 0x${(library.ArenaRoundSeed() >>> 0).toString(16)}`);

      // THE CORE IS IN THE COMMITTEE'S WORLD, and it is the state the next
      // tick will step - not a second core kept beside it.
      assert.equal(inits.length, 2, 'the bridge did not put the core in the round\'s world');
      assert.equal(inits[1].seed, want >>> 0,
        'the bridge seeded a world the committee will not replay this entry in');
      assert.notEqual(inits[1].seed, SOLO_SEED >>> 0);
      assert.equal(Module.arenaCore.st.i32[O_TRUCK + T_Z], bayZ(spawnBay(want)),
        'the core the page will step is not standing where this round parks this player');

      // ---- AND NOW IT DRIVES. ----
      const before = records.length;
      for (let t = 0; t < 30; t++) library.ArenaStep(45875, 22000, 0, 0, 0);
      assert.ok(records.length > before, 'the bridge recorded nothing after joining');
      assert.equal(records.filter((r) => r.initsSoFar < 2).length, 0,
        'a tick was recorded while the core was still in the constant world');
      assert.equal(inits.length, 2, 'the core was re-seeded again after ticks were recorded');

      // READ SITE TWO: `StartRound` takes `ArenaNet.RoundSeed` and only falls
      // back to the constant when it is zero. On a live round it is not.
      assert.equal(library.ArenaRoundSeed() >>> 0, want >>> 0,
        'C# would restart this round\'s core into a world nobody replays');
      assert.notEqual(library.ArenaRoundSeed(), 0);
    } finally {
      CLIENT.Client.prototype.record = realRecord;
      try {
      const cl = Module.arenaNet && Module.arenaNet.client;
      if (cl) { cl.ended = true; cl.close(); }  // ended, then closed: a plain close reads as a drop and reconnects for ever
      // AND THE PAGE'S TICK CLOCK: a BroadcastChannel the bridge keeps for the page's life, which in Node is a live
      // MessagePort - measured: all five tests passed in 3.3 s and the file never exited, held by three of them.
      if (Module && Module.arenaTickClock) Module.arenaTickClock.close();
      } catch { /* gone */ }
    }
  } finally { await round.close(); }
});

/**
 * AND C# CANNOT TAKE THE WORLD BACK, WHENEVER IT ASKS.
 *
 * Two callers seed the core and nothing orders them: `CoreDrivenTruck.Start`
 * calls `ArenaCore.Init` with its own constant, and this bridge calls
 * `core.init` when the join resolves. Whichever ran last won - and both
 * outcomes were photographed in ONE two-Chrome look, one tab driving the
 * round's world at bay 14 (z 17.000 m) while every other page was shown it
 * there, and the other tab driving the harness world at bay 13 (z 10.200 m).
 * A constant 6.800 m apart, one door's pitch, which never closed because it
 * was not lag.
 *
 * So the argument is a default and the round is an answer: once the bridge
 * knows the seed, that is the world however late somebody else asks.
 */
test('once a round is joined, a later Init from C# cannot put the core back in the harness world', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18230, portB: 18231, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  // DECLARED OUT HERE so the teardown can reach it. It was `const` inside the
  // try, so `finally` threw a ReferenceError its own catch swallowed and this
  // client was never closed - harmless while the test ended before the client
  // connected, and a reconnect loop for ever once it waits for recording.
  let Module = null;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const rid = roundId(named.round);
    const beacon = await fetchRandomness(toHex(rid), named.nodes);

    let player, signerNode, entry, want;
    for (let tries = 0; ; tries++) {
      player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
      entry = { ...signerNode, roundId: rid };
      want = seedWordForEntry({ ...entry, sessionPubkey: new Uint8Array(32) }, beacon.randomness);
      if (spawnBay(want) !== spawnBay(SOLO_SEED)) break;
      assert.ok(tries < 200, '200 identities all parked on the harness bay, which is not chance');
    }

    const heap = new Int32Array(64);
    Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
    const library = shippedBridge({
      Module, HEAP32: heap, UTF8ToString: () => named.nodes[0],
      window: { location: { search: new URL(round.url).search } },
      console, crypto, BLWP: core, BLWPCLIENT: CLIENT, BLWP_CURVE: pageCurve,
      BLWP_ROUND: named.round, BLWP_ENTRY: signerNode, BLWP_NODES: named.nodes,
      BLWP_CHAIN: named.chain, BLWP_ADVERT: named.advert,
    });

    assert.equal(library.ArenaInit(SOLO_SEED), 1);
    assert.equal(library.ArenaNetStart(0, 6, 60), 1);
    // until recording begins - where the round's world is entered
    for (let i = 0; i < 200 && !(Module.arenaNet.client && Module.arenaNet.client.where); i++) await wait(50);
    assert.ok(Module.arenaNet.client, `the session never opened: ${Module.arenaNet.error}`);

    const roundZ = Module.arenaCore.st.i32[O_TRUCK + T_Z];
    assert.equal(roundZ, bayZ(spawnBay(want)), 'the join did not put the core in the round\'s world');

    // NOW C# ASKS AGAIN, LATE, with its own constant - which is exactly the
    // race the look caught. The round's world has to survive it.
    assert.equal(library.ArenaInit(SOLO_SEED), 1);
    assert.equal(Module.arenaCore.st.i32[O_TRUCK + T_Z], roundZ,
      'a late Init from C# put the player back in the harness world');
    assert.notEqual(Module.arenaCore.st.i32[O_TRUCK + T_Z], bayZ(spawnBay(SOLO_SEED)));

    // AND SO DOES A RESTART, which is what a roll-out would do on the daily.
    library.ArenaRestart(SOLO_SEED);
    assert.equal(Module.arenaCore.st.i32[O_TRUCK + T_Z], roundZ,
      'a restart put the player back in the harness world');
    console.log(`  the round parks this player at z ${(roundZ / 65536).toFixed(3)} m and `
      + `two late calls with 0x${(SOLO_SEED >>> 0).toString(16)} left it there`);
  } finally {
    try {
        const cl = Module?.blwpNet?.client;
        if (cl) { cl.ended = true; cl.close(); }  // ended, then closed: a plain close reads as a drop and reconnects for ever
        // AND THE PAGE'S TICK CLOCK: a BroadcastChannel the bridge keeps for the page's life, which in Node is a live
        // MessagePort - measured: all five tests passed in 3.3 s and the file never exited, held by three of them.
        if (Module && Module.arenaTickClock) Module.arenaTickClock.close();
    } catch { /* gone */ }
    await round.close();
  }
});

/**
 * AND WITH NO ROUND, THE CONSTANT IS THE ANSWER AND MUST BE.
 *
 * `ArenaRoundSeed` is 0 when there is no session, which is what keeps the
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
  assert.equal(library.ArenaRoundSeed(), 0, 'a page with no round named a round seed');
  assert.equal(spawnBay(SOLO_SEED), 13, 'the harness seed left the solo bay');
});

/**
 * AND WHAT A ROLL-OUT DOES TO A TRANSCRIPT THAT IS ALREADY RUNNING.
 *
 * `LoadoutPanel` calls `CoreDrivenTruck.StartRound` when the bay shuts, and
 * that calls `ArenaCore.Restart(world)` - the core's own `init` again. On the
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
  // of them is recorded - `ArenaStep` hands them over whatever the game is
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

/**
 * THE TICK A TAB PUBLISHES IS THE TICK ITS CORE IS ON, HOWEVER SLOW THE JOIN.
 *
 * Measured 2026-09-10 in two real Chromes, hooks installed before load: with
 * 400 ms of latency on one tab, 16, 16, 16 and 24 ticks were stepped between
 * the bridge's seed reset and `setRound` and never recorded; at normal speed,
 * 0 and 0. That tab published 16-24 ticks behind its own core for the rest of
 * the run, and the other tab's ghost of it was that many ticks late by label -
 * 283 and 623 mm while driving. No C# reset fired after recording began.
 *
 * So the join is held open here at its first round trip after the seed -
 * `openRound`, with `join`, `connect` and `setRound` chained behind it,
 * waits on a latch - while the shipped bridge steps the game 24 times. It was
 * held at the global `fetch` first, and that also held the two daemons' own
 * peer requests in this one process: the file never exited.
 */
test('a join held open while the game steps publishes from the tick the core is on, and marks name it', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18240, portB: 18241, configHash: TRUCK_V3_CONFIG_HASH });
  const realOpen = CLIENT.Client.prototype.openRound;
  const realRecord = CLIENT.Client.prototype.record;
  const realMark = CLIENT.Client.prototype.markNow;
  let gated = 0;
  let release;
  const latch = new Promise((r) => { release = r; });
  CLIENT.Client.prototype.openRound = async function (...args) {
    gated++;
    await latch;
    return realOpen.apply(this, args);
  };
  let Module = null;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
    const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });

    const heap = new Int32Array(64);
    Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
    let first = null;
    const marks = [];
    CLIENT.Client.prototype.record = function (words) {
      const ok = realRecord.call(this, words);
      if (ok !== false && !first) first = { core: Module.arenaCore.st.i32[0], published: this.nextTick + this.held };
      return ok;
    };
    // THE LABEL THE BRIDGE HANDS A CHECKPOINT IS WHAT IS PINNED, not the
    // node's check of it (other suites carry that). Recorded and not sent: a
    // checkpoint sent to these daemons starts a replay worker that outlives
    // `round.close()` - measured, two pipes left open and the file never exits.
    CLIENT.Client.prototype.markNow = function (hash, tick) {
      marks.push({ tick, core: Module.arenaCore.st.i32[0] });
      return null;
    };
    const library = shippedBridge({
      Module, HEAP32: heap, UTF8ToString: () => named.nodes[0],
      window: { location: { search: new URL(round.url).search } },
      console, crypto, BLWP: core, BLWPCLIENT: CLIENT, BLWP_CURVE: pageCurve,
      BLWP_ROUND: named.round, BLWP_ENTRY: signerNode, BLWP_NODES: named.nodes,
      BLWP_CHAIN: named.chain, BLWP_ADVERT: named.advert,
    });

    assert.equal(library.ArenaInit(SOLO_SEED), 1);
    assert.equal(library.ArenaNetStart(0, 6, 60), 1);
    for (let i = 0; i < 200 && gated === 0; i++) await wait(50);
    assert.ok(gated > 0, `the join never reached the round trips this holds open: ${Module.arenaNet.error}`);

    // THE GAME STEPS WHILE THE JOIN IS HELD - the slow tab, on purpose.
    const HELD_STEPS = 24;
    for (let t = 0; t < HELD_STEPS; t++) library.ArenaStep(45875, 0, 0, 0, 0);
    release();
    for (let i = 0; i < 200 && !(Module.arenaNet.client && Module.arenaNet.client.where); i++) await wait(50);
    const c = Module.arenaNet.client;
    assert.ok(c && c.where, `recording never began: ${Module.arenaNet.error}`);

    for (let t = 0; t < 90; t++) library.ArenaStep(45875, 0, 0, 0, 0);
    const coreNow = Module.arenaCore.st.i32[0];
    // A BATCH IN FLIGHT IS IN NEITHER NUMBER: `drain` slices it out of the
    // hold and `nextTick` moves only on the node's answer, so next-plus-held
    // is short by exactly the batch mid-air (6 here, measured). `offered` is
    // every tick the client accepted; the client itself asserts next + held
    // === offered before each batch. So the two are read with nothing mid-air.
    for (let i = 0; i < 100 && c.publishing; i++) await wait(50);
    console.log(`  ${HELD_STEPS} steps with the join held: first recorded tick published as `
      + `${first && first.published} with the core at ${first && first.core}; after 90 more, `
      + `offered ${c.offered}, published ${c.nextTick}+${c.held} = ${c.nextTick + c.held}, core ${coreNow}; `
      + `marks at ${marks.map((m) => `${m.tick}/${m.core}`).join(' ') || 'none'}`);

    assert.ok(first, 'nothing was recorded after the join');
    assert.equal(first.published, first.core,
      `the first recorded tick was published as ${first.published} with the core at ${first.core}`);
    assert.equal(c.publishing, null, 'a batch was still in flight after five seconds');
    assert.equal(c.offered, coreNow, `the tab accepted ${c.offered} ticks while its core is on ${coreNow}`);
    assert.equal(c.nextTick + c.held, coreNow,
      `the tab publishes tick ${c.nextTick + c.held} while its core is on ${coreNow}`);
    assert.ok(marks.length >= 1, 'no checkpoint was taken in 90 ticks at markEvery 60');
    for (const m of marks)
      assert.equal(m.tick, m.core, `a checkpoint named tick ${m.tick} with the core on ${m.core}`);
  } finally {
    CLIENT.Client.prototype.openRound = realOpen;
    CLIENT.Client.prototype.record = realRecord;
    CLIENT.Client.prototype.markNow = realMark;
    // ENDED, THEN CLOSED. `close()` only closes the socket, and the socket's
    // close handler reads any close on a run that is not ended as a DROP and
    // starts the reconnect loop - by design, so a node restart does not end a
    // player's session. Traced here: that loop's backoff timer was the one
    // thing left alive, and this file never exited.
    try {
      const cl = Module?.blwpNet?.client;
      if (cl) { cl.ended = true; cl.close(); }
      // AND THE PAGE'S TICK CLOCK: a BroadcastChannel the bridge keeps for the page's life, which in Node is a live
      // MessagePort - measured: all five tests passed in 3.3 s and the file never exited, held by three of them.
      if (Module && Module.arenaTickClock) Module.arenaTickClock.close();
    } catch { /* gone */ }
    await round.close();
  }
});
