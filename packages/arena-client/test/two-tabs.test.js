// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO TABS, TWO IDENTITIES, ONE ROUND THE DAEMONS AGREED ON.
//
// This is the page's own path, in `node --test`: the URL an operator prints,
// parsed the way `index.html` parses it, handed to `Client.at` the way
// `arena.jslib` hands it - the whole discovery, so the chain is asked for from
// two providers, the bond is proven into it, the advertisement's signature is
// checked, and the node's address is READ OFF that bond rather than taken from
// the query. Then two players join, one drives, and the other is shown a
// picture of them.
//
// What it does not do is look at a screen. The drawn pose is measured in
// PlayMode against this same capture, at delta zero; what is measured here is
// everything up to the renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
//: these are about PER-PLAYER worlds (the bridge must not fall back to the harness seed), so their rounds name the
// per-player config v3; the shared world (v4) is world-shared.test.js and world-shared-door.test.js.
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { watchGhosts } from '../../nextblock/page/ghost-field.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { init as coreInit, step as coreStep } from '../../nextblock/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../nextblock/src/state.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { toHex as hex } from '../../arena-protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
// The beacon the daemons were stood up with, so the seed is derivable here.
const BEACON = new Uint8Array(32).fill(0xbe);
const fromHexHere = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/**
 * A BITCOIND, WITHOUT A BITCOIND.
 *
 * The 2-of-2 tool used to answer every beacon question with a constant, and a
 * committee drawn on a constant is a committee its operator chose. That is
 * gone, so these nodes need a chain - and a suite that needs a daemon is a
 * suite nobody runs. This is the same fake node `chain-rpc.test.js` uses: a
 * real mined chain, served over the RPC calls the reader makes, with its
 * timestamps straddling now so the round's own committee_time has a block
 * after it.
 */
function chainNode({ blocks = 40, spacing = 600 } = {}) {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const now = Math.floor(Date.now() / 1000);
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < blocks; i++) {
    // Half the chain before now and half after, so a block whose MEDIAN is
    // after committee_time exists with depth to spare. The median lags the tip
    // by five blocks, which is why the crossing point is not the middle.
    const time = now + (i - 20) * spacing;
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time });
    headers.push(header);
    previous = blockHashOf(header);
  }
  const firstHeight = 0;            // a regtest starts at genesis, and so does this
  return async (method, params = []) => {
    if (method === 'getblockcount') return firstHeight + headers.length - 1;
    if (method === 'getblockhash') return hex(blockHashOf(headers[params[0] - firstHeight]));
    if (method === 'getblockheader') {
      const at = headers.findIndex((h) => hex(blockHashOf(h)) === params[0]);
      return hex(headers[at]);
    }
    throw new Error('this fake node was asked ' + method);
  };
}

test('a person opens the printed URL twice and the two tabs are on one round', async () => {
  // NO HEADER SOURCE HANDED IN. The tool builds one chain that carries the
  // bonds and names the beacon; a separate header source would be a census on
  // one chain and a seed on another, which is what letter 32 closed.
  const round = await standUpRound({ host: "127.0.0.1", portA: 18080, portB: 18081, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  try {
    // WHAT THE PAGE DOES WITH ITS OWN ADDRESS BAR, on the URL the operator
    // printed - not a hand-built object.
    const search = new URL(round.url).search;
    const named = await joinFromQuery(search);
    assert.ok(named, 'the printed URL named no round');
    assert.equal(toHex(roundId(named.round)), round.id,
      'the page joined a round that is not the one the URL named');

    for (const which of ['one', 'two']) {
      const secret = ed25519.utils.randomSecretKey();
      const sessionPubkey = ed25519.getPublicKey(secret);
      const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });

      // EXACTLY WHAT THE JSLIB HANDS OVER, including the round id the player
      // was given - the door refuses a contract that does not hash to it.
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify,
        contract: named.round,
        roundIdGiven: fromHexHere(round.id),
      });

      const rid = await client.openRound(named.round);
      assert.equal(toHex(rid), round.id, which + ': the node named a different round');
      const entry = { ...signerNode, roundId: rid, sessionPubkey };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry });
    }

    assert.equal(tabs.length, 2);
    assert.notEqual(toHex(tabs[0].eid), toHex(tabs[1].eid),
      'the two tabs are one player, so neither would ever see the other');

    // TAB ONE DRIVES FIRST. A player with no published inputs is nobody to
    // draw - the interest set is over runs the node can replay, not over
    // sockets that happen to be open - so the driving comes before the asking,
    // which is also the order a person arrives in.
    for (let t = 0; t < 90; t++) tabs[0].client.record([45875, 0, 0, 0, 0]);
    await tabs[0].client.drain();

    // TAB TWO ASKS TO BE SHOWN THE OTHER TRUCKS and is shown one - tab one's
    // entry and nobody else's, never a picture of itself.
    const field = watchGhosts(tabs[1].client, { roundId: tabs[1].entry.roundId, entryId: tabs[1].eid });
    assert.equal(await field.watching, 'watching 1', 'the page was shown nobody');

    for (let t = 0; t < 30; t++) tabs[1].client.record([45875, 0, 0, 0, 0]);
    await tabs[1].client.drain();
    await wait(150);

    const seen = field.latest();
    assert.ok(seen.length >= 1, 'the second tab was never shown the first tab\'s truck');
    assert.equal(toHex(seen[0].entryId), toHex(tabs[0].eid),
      'the picture is of the wrong player');
    // AND THE POSE IS TAB ONE'S OWN RUN, driven here rather than taken on
    // trust: the same core, the same inputs, the same seed - which comes from
    // that player's entry and the round's beacon, so nobody else can compute
    // it for them.
    const randomness = (round.beacon && round.beacon.hash) ? round.beacon.hash : BEACON;
    const st = coreInit(seedWordForEntry(tabs[0].entry, randomness));
    for (let t = 0; t <= seen[0].tick; t++) coreStep(st, 45875, 0, 0, 0, 0);
    const was = {
      x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z],
      heading: st.i32[O_TRUCK + T_HEADING],
    };
    console.log(`  tab two was shown tab one at tick ${seen[0].tick}: `
      + `x ${seen[0].x} z ${seen[0].z} heading ${seen[0].heading}`);
    console.log(`  tab one's own transcript at that tick: `
      + `x ${was.x} z ${was.z} heading ${was.heading}  -> delta `
      + `${seen[0].x - was.x} ${seen[0].z - was.z} ${seen[0].heading - was.heading}`);
    assert.equal(seen[0].x, was.x, 'the page has the truck somewhere the core never put it');
    assert.equal(seen[0].z, was.z);
    assert.equal(seen[0].heading, was.heading);
    assert.notEqual(seen[0].x, 0, 'the truck is drawn at the origin, which is not a run');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* already gone */ } }
    await round.close();
  }
});

/**
 * THE CASE THE 11:51 RETEST FAILED ON: a tab that has NOT driven.
 *
 * the owner, two Chrome windows: P1 loaded, rolled out and drove in the field;
 * P2 stayed in the cargo loadout on the dirt and saw only its own truck. The
 * chip read `A ok · B ok · play · A up · 5 players` - the socket did NOT drop
 * this time - so the question is no longer whether frames can be delivered but
 * whether a watcher who has published nothing is sent any.
 *
 * The test above has tab two drive thirty ticks before it looks. This one
 * never drives it, which is what a person sitting in the loadout is.
 */
test('a tab that has not driven is still shown the truck that is driving', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18084, portB: 18085, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    for (const which of ['driver', 'watcher']) {
      const secret = ed25519.utils.randomSecretKey();
      const sessionPubkey = ed25519.getPublicKey(secret);
      const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
      });
      const rid = await client.openRound(named.round);
      const entry = { ...signerNode, roundId: rid, sessionPubkey };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry });
    }
    const [driver, watcher] = tabs;

    // THE WATCHER SUBSCRIBES THE MOMENT IT HAS A ROUND AND AN ENTRY, which is
    // what `arena.jslib` does - before anybody has driven anything.
    const field = watchGhosts(watcher.client, {
      roundId: watcher.entry.roundId, entryId: watcher.eid,
    });
    assert.match(await field.watching, /^watching /);

    // AND NEVER DRIVES. Only the driver moves.
    const poses = [];
    for (let batch = 0; batch < 8; batch++) {
      for (let t = 0; t < 6; t++) driver.client.record([45875, 0, 0, 0, 0]);
      await driver.client.drain();
      await wait(120);
      const seen = field.latest().filter((g) => toHex(g.entryId) === toHex(driver.eid));
      if (seen.length) poses.push({ tick: seen[0].tick, x: seen[0].x, z: seen[0].z });
    }

    console.log(`  the watcher never drove and was shown ${poses.length} pictures of the driver`);
    if (poses.length) {
      console.log(`  first tick ${poses[0].tick} at x ${poses[0].x} z ${poses[0].z}`);
      console.log(`  last  tick ${poses[poses.length - 1].tick} at x ${poses[poses.length - 1].x} `
        + `z ${poses[poses.length - 1].z}`);
    }

    assert.ok(poses.length > 0,
      'a tab that has not driven is shown nothing, which is the loadout tab in the retest');
    const distinct = new Set(poses.map((p) => `${p.x}:${p.z}`)).size;
    assert.ok(distinct > 1,
      `the picture never moved: ${distinct} distinct pose(s) over ${poses.length} frames`);
    assert.ok(poses[poses.length - 1].tick > poses[0].tick,
      'the picture stopped advancing while the driver kept driving');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* gone */ } }
    await round.close();
  }
});

/**
 * WHAT THE RENDERER ACTUALLY DOES, which is drain and not look.
 *
 * `ArenaNextGhost` takes ONE picture per call and `GhostField.Draw(PerFrame)`
 * calls it up to 24 times a frame, so in a real page the queue is empty
 * almost always. The test above asked `latest()` without ever draining, which
 * is not what the page does - and `latest()` used to read the queue, so a
 * consumer that drew its frame and then asked what it was holding was told
 * nothing while the trucks were still in the round.
 *
 * This drives the field the way the bridge drives it: drain one at a time,
 * every "frame", and watch the pose advance.
 */
test('a renderer that drains one picture a frame keeps getting the driver\'s new pose', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18086, portB: 18087, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    for (const which of ['driver', 'watcher']) {
      const secret = ed25519.utils.randomSecretKey();
      const sessionPubkey = ed25519.getPublicKey(secret);
      const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
      });
      const rid = await client.openRound(named.round);
      const entry = { ...signerNode, roundId: rid, sessionPubkey };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry });
    }
    const [driver, watcher] = tabs;
    const field = watchGhosts(watcher.client, {
      roundId: watcher.entry.roundId, entryId: watcher.eid,
    });
    await field.watching;

    const drawn = [];
    for (let batch = 0; batch < 8; batch++) {
      for (let t = 0; t < 6; t++) driver.client.record([45875, 0, 0, 0, 0]);
      await driver.client.drain();
      await wait(120);
      // THE FRAME: take what can be drawn, exactly as `Draw(PerFrame)` does.
      for (const g of field.drain(24))
        if (toHex(g.entryId) === toHex(driver.eid)) drawn.push({ tick: g.tick, x: g.x, z: g.z });
    }

    console.log(`  the renderer drew ${drawn.length} picture(s) of the driver over 8 batches`);
    assert.ok(drawn.length >= 8, `the renderer was handed ${drawn.length} pictures, not one per batch`);
    assert.ok(drawn[drawn.length - 1].tick > drawn[0].tick, 'the pose stopped advancing');
    assert.ok(new Set(drawn.map((d) => `${d.x}:${d.z}`)).size > 1, 'every picture was the same pose');

    // AND AFTER THE FRAME IS DRAWN the field still knows who is in the round -
    // the queue is empty and the truck is not gone.
    assert.equal(field.size, 0, 'the renderer left pictures undrawn');
    assert.equal(field.others, 1, 'a truck that was drawn stopped being in the round');
    const still = field.latest();
    assert.equal(still.length, 1, 'a drawn truck vanished from latest(), which is the 11:51 symptom');
    assert.equal(still[0].tick, drawn[drawn.length - 1].tick,
      'latest() is not the newest picture the renderer was given');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* gone */ } }
    await round.close();
  }
});

test('two daemons whose chains disagree stop the join by name', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18082, portB: 18083, configHash: TRUCK_V3_CONFIG_HASH });
  try {
    const named = await joinFromQuery(new URL(round.url).search);

    // ONE PROVIDER IS SWAPPED FOR A DIFFERENT CHAIN. Not a broken one - a
    // well-formed set of headers that is simply not the chain the other
    // provider is on, which is the case `agreedChain` exists for: two
    // providers who fork are two providers of whom at least one is lying or
    // broken, and picking the heavier one would be guessing which.
    const other = blockOf(hash256, [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
      { previous: blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER) });
    const forked = new Uint8Array(160);
    forked.set(BITCOIN_MAINNET_GENESIS_HEADER, 0);
    forked.set(other.header, 80);
    const liar = () => Promise.resolve([BITCOIN_MAINNET_GENESIS_HEADER, other.header]);
    liar.tag = 'http://forked.test';

    const secret = ed25519.utils.randomSecretKey();
    await assert.rejects(Client.at({
      headers: [named.chain.headers[0], liar], bonds: named.chain.bonds,
      signedAdvert: fromHexHere(named.advert.signedAdvert),
      committee: named.round.nodes,
    }, {
      core: { hash: (st) => core.hash(st) },
      sign: (id) => ed25519.sign(id, secret),
      verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
    }), (e) => {
      console.log('  refused: ' + e.message);
      assert.match(e.message, /no proven endpoint|chain/i);
      return true;
    });
  } finally { await round.close(); }
});

/**
 * THE TWELVE INTS C# ACTUALLY READS, off the real jslib, off a real driver.
 *
 * Everything above stops at `field.drain(24)`, and the renderer does not call
 * that: it calls `ArenaNextGhost`, which lives in `arena.jslib` - the one file
 * these suites were said not to be able to load. So the 11:51 failure had a
 * whole hop with no measurement in it, between a queue this file proved full
 * and a `GhostField` the built player proved it constructs.
 *
 * `bridge.test.js` already evaluates that file - the whole thing is one
 * `mergeInto(LibraryManager.library, {...})` call, so an object literal is
 * what it is - and it never touched the ghost export, because the ghost export
 * is the only one that writes through the bare `HEAP32` its harness has no
 * name for. So this hands it one.
 *
 * DECODED THE WAY THE GAME DECODES IT. `GhostField.FromBridge` refuses
 * anything but exactly `Words` back, reads eight words as `ToString("x8")` and
 * takes x, z, heading and tick from the four after them. That is transcribed
 * here from the C# rather than from the jslib, so an encoder and a decoder
 * that agree with each other but not with the game do not both pass.
 */
test('the shipped bridge writes the driver\'s entry and pose in the twelve ints C# reads', async () => {
  const cs = readFileSync(new URL('../../nextblock/unity/Assets/Scripts/Arena/GhostField.cs', import.meta.url), 'utf8');
  const WORDS = Number(/public const int Words = (\d+)/.exec(cs)[1]);
  const PER_FRAME = Number(/public const int PerFrame = (\d+)/.exec(cs)[1]);
  assert.equal(WORDS, 12, 'the game reads a different picture size than the bridge writes');

  // The jslib, evaluated: `mergeInto` keeps what it is handed, and the bare
  // `HEAP32` the ghost export writes through is a real Int32Array here.
  const jslib = readFileSync(new URL('../../nextblock/unity/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  const heap = new Int32Array(64);
  const Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
  let library = null;
  new Function('mergeInto', 'LibraryManager', 'Module', 'UTF8ToString', 'window', 'HEAP32', jslib)(
    (_t, obj) => { library = obj; }, { library: {} }, Module, () => '',
    { location: { search: '' } }, heap);

  /** `GhostField.FromBridge`, in the words the C# uses. */
  const fromBridge = () => {
    if (library.ArenaNextGhost(0, WORDS) !== WORDS) return null;
    let entry = '';
    for (let i = 0; i < 8; i++) entry += (heap[i] >>> 0).toString(16).padStart(8, '0');
    return { entry, x: heap[8], z: heap[9], heading: heap[10], tick: heap[11] };
  };

  const round = await standUpRound({ host: '127.0.0.1', portA: 18088, portB: 18089, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    for (const which of ['driver', 'watcher']) {
      const secret = ed25519.utils.randomSecretKey();
      const sessionPubkey = ed25519.getPublicKey(secret);
      const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
      const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
      });
      const rid = await client.openRound(named.round);
      const entry = { ...signerNode, roundId: rid, sessionPubkey };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry });
    }
    const [driver, watcher] = tabs;

    // The page's own hop: the jslib asks `arena-client` for the field and
    // holds it on `Module.arenaNet`, which is where the ghost export looks.
    Module.arenaNet = {
      ghosts: watchGhosts(watcher.client, {
        roundId: watcher.entry.roundId, entryId: watcher.eid,
      }),
    };
    await Module.arenaNet.ghosts.watching;

    // WHAT THE PAGE HELD, next to what C# was given. A bridge that agrees with
    // itself proves nothing: the picture that comes out has to be the picture
    // that went in, field for field, or a truck is drawn somewhere its
    // transcript never said it was.
    const handed = [];
    const drainAsPage = Module.arenaNet.ghosts.drain;
    Module.arenaNet.ghosts.drain = (max) => {
      const took = drainAsPage(max);
      for (const g of took) handed.push(g);
      return took;
    };

    // BEFORE ANYTHING ARRIVES. A field Unity has not seen hands it the CLEAR record first (tick -2, entry all zero:
    // `GhostField.ClearTick`), so no truck of the last round stands in this one - the rule the 17:12 ghost letter added.
    // Then an empty field hands out nothing.
    assert.equal(library.ArenaNextGhost(0, WORDS), WORDS, 'a new field did not clear the last round\'s trucks');
    assert.equal(heap[11], -2, 'the first record of a new field is not the clear');
    assert.deepEqual([...heap.slice(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0], 'the clear record names an entry');
    assert.equal(library.ArenaNextGhost(0, WORDS), 0, 'an empty field handed out a picture');

    const drawn = [];
    for (let batch = 0; batch < 8; batch++) {
      // Throttle AND steer, so the heading word moves too: a bridge that drops
      // the heading and a truck driving in a straight line look the same.
      for (let t = 0; t < 6; t++) driver.client.record([45875, 22000, 0, 0, 0]);
      await driver.client.drain();
      await wait(120);
      // THE FRAME, as `Update` runs it: `Draw(PerFrame)` calls the bridge up
      // to PerFrame times and stops at the first empty answer.
      for (let i = 0; i < PER_FRAME; i++) {
        const picture = fromBridge();
        if (picture == null) break;
        drawn.push(picture);
      }
    }

    const mine = toHex(driver.eid);
    const his = drawn.filter((d) => d.entry === mine);
    assert.equal(drawn.length, handed.length, 'a picture the page handed over was not decoded');
    for (let i = 0; i < drawn.length; i++) {
      const was = handed[i], now = drawn[i];
      assert.equal(now.entry, toHex(was.entryId), 'the entry id changed across the bridge');
      assert.equal(now.x, was.x | 0, 'x changed across the bridge');
      assert.equal(now.z, was.z | 0, 'z changed across the bridge');
      assert.equal(now.heading, was.heading | 0, 'the heading changed across the bridge');
      assert.equal(now.tick, was.tick | 0, 'the tick changed across the bridge');
    }
    console.log(`  C# would have decoded ${drawn.length} picture(s), ${his.length} of the driver`);
    assert.ok(his.length >= 8,
      `the bridge handed C# ${his.length} pictures of the driver, not one per batch`);
    assert.equal(drawn.length, his.length, 'the bridge handed C# a picture of somebody nobody joined as');
    assert.ok(his[his.length - 1].tick > his[0].tick, 'the decoded pose stopped advancing');
    assert.ok(new Set(his.map((d) => `${d.x}:${d.z}`)).size > 1,
      'every decoded picture was the same pose');
    // AND IT IS A PLACE, not a word that survived the trip in the wrong units:
    // 45875 is full throttle, so a truck that drove for 48 ticks has moved,
    // and `GhostTruck.Show` divides these by 65536 to get metres.
    // AND THE RENDERER'S OWN TEST DRAWS THESE, not numbers invented in C#.
    // `DUMP_GHOSTS_DRIVE=<path>` writes exactly what the shipped bridge wrote,
    // twelve ints a line, for the PlayMode test to put on screen.
    if (process.env.DUMP_GHOSTS_DRIVE) {
      const lines = [
        '# What the SHIPPED ArenaNextGhost wrote, driving, over a real 2-of-2 round.',
        '# Twelve ints a line - the entry id as eight words, then x, z, heading, tick.',
        `# entry ${mine}`,
        `# ${his.length} pictures, ticks ${his[0].tick}..${his[his.length - 1].tick}`,
      ];
      // THE ENTRY ID AS C# READS IT: eight big-endian words, the same eight
      // `FromBridge` reassembles into a hex string. Written once - it is the
      // same driver on every line.
      const words = [];
      for (let i = 0; i < 8; i++) {
        const b = i * 4, e = driver.eid;
        words.push(((e[b] << 24) | (e[b + 1] << 16) | (e[b + 2] << 8) | e[b + 3]) | 0);
      }
      for (const d of his) lines.push([...words, d.x, d.z, d.heading, d.tick].join(' '));
      writeFileSync(process.env.DUMP_GHOSTS_DRIVE, lines.join('\n') + '\n');
    }

    const far = Math.max(...his.map((d) => Math.abs(d.x / 65536) + Math.abs(d.z / 65536)));
    console.log(`  the farthest decoded pose is ${far.toFixed(1)} m from the origin`);
    assert.ok(far > 0.5, `the driver was decoded standing at ${far} m from the origin`);

    // AND A BACKLOG IS THE NEWEST PICTURE OF THAT TRUCK, NOT A QUEUE OF WHERE IT WAS.
    //
    // A page that is drawing every frame almost never holds two pictures at once, so the traffic above cannot tell a
    // bridge that takes one from a bridge that takes two and drops one. This lets the queue fill first, which is what a
    // page does whenever a frame is late - and since 628d54a (2026-09-17 17:05 / 17:12: "the ghost must be
    // REALTIME") a frame then draws each truck where its NEWEST picture puts it and the older ones are collapsed, so
    // one truck's backlog is one picture and the rest are counted.
    for (let batch = 0; batch < 3; batch++) {
      for (let t = 0; t < 6; t++) driver.client.record([45875, 0, 0, 0, 0]);
      await driver.client.drain();
      await wait(120);
    }
    const backlog = Module.arenaNet.ghosts.size;
    assert.ok(backlog >= 3, `the field held ${backlog} pictures, so a backlog was never made`);

    // A PICTURE TOO SMALL TO HOLD ONE takes nothing and writes nothing, with
    // the queue full - the answer an empty field gives is the same either way.
    assert.equal(library.ArenaNextGhost(0, WORDS - 1), 0, 'the bridge wrote past what it was given');
    assert.equal(Module.arenaNet.ghosts.size, backlog,
      'the bridge ate a picture it could not hand over');

    const after = [];
    for (let i = 0; i < PER_FRAME; i++) {
      const picture = fromBridge();
      if (picture == null) break;
      after.push(picture);
    }
    const trucks = new Set(Module.arenaNet.ghosts.latest().map((g) => toHex(g.entryId))).size;
    assert.equal(after.length, trucks,
      `the frame drew ${after.length} pictures of ${trucks} truck(s) from a backlog of ${backlog}`);
    assert.equal(Module.arenaNet.ghosts.size, 0, 'a picture was left in the page after the frame drained it');
    assert.ok(Module.arenaNet.ghosts.collapsed >= backlog - trucks,
      `${backlog} pictures collapsed to ${after.length} and the page counted ${Module.arenaNet.ghosts.collapsed}`);
    for (const d of after) assert.equal(d.tick, Math.max(...his.map((h) => h.tick), d.tick), 'a truck was drawn at an older picture than the page held');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* gone */ } }
    await round.close();
  }
});
