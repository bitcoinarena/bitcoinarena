// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO PLAYERS OF A SHARED WORLD AT TWO DOORS, FROM THE PAGE'S SIDE (kanban #828, the owner 2026-10-31: "Die müssen an unterschiedlichen
// Slots starten, nah beinander dass man sich sieht"). A hash alone gives two players one door 1 time in 12, so a page reads the entries
// the round's seats hold before it makes its own (GET /api/round-result) and draws its session key again while the id lands on a place
// listed. The bridge is the SHIPPED arena.jslib against two real daemons, as world-seed-bridge.test.js evaluates it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { TRUCK_SHARED_CONFIG_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { joinFromQuery, tabSeed, playerFor, entryFor, keyOnFreeSlot, slotsTaken, worldSeedFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { worldSlot, slotOfEntryId, worldSeedWord, WORLD_SLOTS } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { O_TRUCK, T_Z } from '../../nextblock/frozen/8cbc74b2/state.js';
import { bayZ, slotBay } from '../../nextblock/frozen/8cbc74b2/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/core-8cbc74b2.js');
const CLIENT = require('../dist/arena-client.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const hexOf = (b) => toHex(b);

function shippedBridge(globals) {
  const src = readFileSync(new URL('../../../.apps/arena-app-next-block/unity/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  const names = Object.keys(globals);
  const load = (helpers) => {
    let lib = null;
    const hn = Object.keys(helpers);
    new Function('mergeInto', 'LibraryManager', ...hn, ...names, src)((_t, obj) => { lib = obj; }, { library: {} },
      ...hn.map((n) => helpers[n]), ...names.map((n) => globals[n]));
    return lib;
  };
  const first = load({});
  const helpers = {};
  for (const k of Object.keys(first)) if (k.startsWith('$')) helpers[k.slice(1)] = first[k];
  return load(helpers);
}

/** One tab: the shipped bridge, joined to the round. */
async function tab(round, named, sessionStorage = storage(), kept = null) {
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const signerNode = kept || entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const heap = new Int32Array(64);
  const Module = { HEAPU8: new Uint8Array(heap.buffer) };
  const library = shippedBridge({
    Module, HEAP32: heap, UTF8ToString: () => named.nodes[0],
    window: { location: { search: new URL(round.url).search }, sessionStorage },
    console: { log() {}, error: console.error }, crypto, BLWP: core, ARENACLIENT: CLIENT, ARENA_CURVE: pageCurve,
    ARENA_ROUND: named.round, ARENA_ENTRY: signerNode, ARENA_NODES: named.nodes, ARENA_CHAIN: named.chain, ARENA_ADVERT: named.advert,
  });
  assert.equal(library.ArenaInit(0x5eed1234), 1);
  assert.equal(library.ArenaNetStart(0, 6, 60), 1);
  for (let i = 0; i < 200 && !(Module.arenaNet.client && Module.arenaNet.client.where); i++) await wait(50);
  assert.ok(Module.arenaNet.client, `the session never opened: ${Module.arenaNet.error}`);
  return { Module, library, signerNode, close() {
    const cl = Module.arenaNet && Module.arenaNet.client;
    if (cl) { cl.ended = true; cl.close(); }
    if (Module.arenaTickClock) Module.arenaTickClock.close();
  } };
}

test('two tabs of one shared-world round, through the shipped bridge: one seed word, two doors, each where its entry says', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18840, portB: 18841, configHash: TRUCK_SHARED_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const rid = roundId(named.round);
    const sharedWorld = sharedWorldOf(named.round.gameId);
    assert.ok(sharedWorld.length, 'this round\'s game shares a world');
    tabs.push(await tab(round, named));
    tabs.push(await tab(round, named));
    const [a, b] = tabs.map((t) => t.Module.arenaNet);
    assert.equal(a.seedWord, b.seedWord, 'one world');
    for (const t of tabs) {
      const net = t.Module.arenaNet;
      assert.equal(net.slot, slotOfEntryId(net.where.entryId), 'the entry\'s own place');
      assert.equal(t.Module.arenaCore.st.i32[O_TRUCK + T_Z], bayZ(slotBay(net.seedWord, net.slot)), 'the core stands where the seats replay it from');
      // AND C# CANNOT TAKE THE PLACE BACK, WHENEVER IT ASKS: a late Init, a restart
      const z = t.Module.arenaCore.st.i32[O_TRUCK + T_Z];
      t.library.ArenaInit(0x5eed1234);
      assert.equal(t.Module.arenaCore.st.i32[O_TRUCK + T_Z], z, 'a late Init moved the truck');
      t.library.ArenaRestart(0x5eed1234);
      assert.equal(t.Module.arenaCore.st.i32[O_TRUCK + T_Z], z, 'a restart moved the truck');
    }
    assert.notEqual(a.slot, b.slot, 'the second tab saw the first entry and took another door');
    assert.notEqual(tabs[0].Module.arenaCore.st.i32[O_TRUCK + T_Z], tabs[1].Module.arenaCore.st.i32[O_TRUCK + T_Z]);
    // THE LISTING IT READ: both entries, off a live seat, before the round has started
    const listed = await slotsTaken({ round: rid, nodes: named.nodes, waitMs: 3000 });
    assert.deepEqual([...listed].sort(), [a.slot, b.slot].sort());
    console.log(`  #828 two tabs of one round: places ${a.slot} and ${b.slot}, bays ${slotBay(a.seedWord, a.slot)} and ${slotBay(b.seedWord, b.slot)}`);
  } finally {
    for (const t of tabs) try { t.close(); } catch { /* gone */ }
    await round.close();
  }
});

test('a reload keeps its key, so its entry and its door: no redraw over its own listed place', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18842, portB: 18843, configHash: TRUCK_SHARED_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const kept = storage();
    tabs.push(await tab(round, named, kept));
    const first = tabs[0].Module.arenaNet.sessionPubkey;
    const key = `arena.session.key.${toHex(roundId(named.round))}`;
    assert.equal(JSON.parse(kept.getItem(key)).raw, hexOf(first), 'the drawn key is the one kept');
    const place = tabs[0].Module.arenaNet.slot;
    // THE RELOAD: a new page over the same tab storage and the same entry. Its own place is listed by now, and it must not flee it.
    tabs.push(await tab(round, named, kept, tabs[0].signerNode));
    assert.deepEqual(tabs[1].Module.arenaNet.sessionPubkey, first, 'a reload drew another key');
    assert.equal(tabs[1].Module.arenaNet.slot, place, 'a reload moved the door');
  } finally {
    for (const t of tabs) try { t.close(); } catch { /* gone */ }
    await round.close();
  }
});

// keyOnFreeSlot WITH THE KEYS SCRIPTED, so the collision is forced rather than waited for
const contractShared = async (port) => {
  const round = await standUpRound({ host: '127.0.0.1', portA: port, portB: port + 1, configHash: TRUCK_SHARED_CONFIG_HASH });
  const named = await joinFromQuery(new URL(round.url).search);
  const signerNode = entryFor(named.round, { seed: playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup }).seed, curve: feldmanGroup, random });
  return { round, named, signerNode, rid: roundId(named.round), sharedWorld: sharedWorldOf(named.round.gameId) };
};

test('keyOnFreeSlot draws again while the id lands on a listed place, stops at the first free one, and gives up without refusing', async () => {
  const { round, named, signerNode, rid, sharedWorld } = await contractShared(18844);
  try {
    const slotOf = (raw) => worldSlot({ entry: { ...signerNode, roundId: rid, sessionPubkey: raw }, contract: named.round, sharedWorld });
    const fresh = () => ({ raw: random(32) });
    const held = fresh();
    const taken = slotOf(held.raw);
    const entryWith = (place) => { for (;;) { const k = fresh(); if (slotOf(k.raw) === place) return k; } };
    const listing = (places) => async () => ({ ok: true, json: async () => ({ players: places.map((p) => ({ entry: hexOfSlot(p) })) }) });
    const hexOfSlot = (p) => { for (;;) { const id = random(32); if (slotOfEntryId(id) === p) return toHex(id); } };

    // a forced collision: the first key lands on the listed place, the second does not
    const script = [held, entryWith((taken + 1) % WORLD_SLOTS)];
    let drew = 0;
    const got = await keyOnFreeSlot({ makeKey: async () => script[drew++], entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: listing([taken]) });
    assert.equal(drew, 2, 'one redraw');
    assert.equal(got, script[1]);

    // half the places held: a free one, every time
    const half = [0, 2, 4, 6, 8, 10];
    for (let i = 0; i < 40; i++) {
      const k = await keyOnFreeSlot({ makeKey: async () => fresh(), entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: listing(half) });
      assert.ok(!half.includes(slotOf(k.raw)));
    }
    // every place held: the first key, nothing burned
    drew = 0;
    await keyOnFreeSlot({ makeKey: async () => { drew++; return fresh(); }, entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: listing([...Array(WORLD_SLOTS).keys()]) });
    assert.equal(drew, 1);
    // a seat that refuses, breaks or says nothing costs a place that may be shared, and no refusal
    const silent = () => new Promise(() => {});
    const t0 = Date.now();
    assert.ok(await keyOnFreeSlot({ makeKey: async () => fresh(), entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: silent, waitMs: 80 }));
    assert.ok(Date.now() - t0 < 1000, 'the join waited on a silent seat');
    assert.ok(await keyOnFreeSlot({ makeKey: async () => fresh(), entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: async () => { throw new Error('down'); } }));
    assert.ok(await keyOnFreeSlot({ makeKey: async () => fresh(), entry: signerNode, contract: named.round, nodes: ['http://a'], fetcher: async () => ({ ok: false, status: 500 }) }));
    // what answers late still counts when the others are in, and one of two seats is enough to list a place
    const one = await slotsTaken({ round: rid, nodes: ['http://a', 'http://b'], waitMs: 200,
      fetcher: async (u) => (u.startsWith('http://a') ? listing([3])() : { ok: false, status: 404 }) });
    assert.deepEqual([...one], [3]);
  } finally { await round.close(); }
});

test('a per-player round asks no seat and draws one key, and its world seed names no slot', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18846, portB: 18847, configHash: TRUCK_V3_CONFIG_HASH });
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const signerNode = entryFor(named.round, { seed: playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup }).seed, curve: feldmanGroup, random });
    let asked = 0, drew = 0;
    await keyOnFreeSlot({ makeKey: async () => { drew++; return { raw: random(32) }; }, entry: signerNode, contract: named.round, nodes: named.nodes,
      fetcher: async () => { asked++; throw new Error('not asked'); } });
    assert.deepEqual([asked, drew], [0, 1]);
    const entry = { ...signerNode, roundId: roundId(named.round), sessionPubkey: random(32) };
    const world = await worldSeedFor({ entry, round: roundId(named.round), nodes: named.nodes, contract: named.round });
    assert.equal(world.slot, undefined);
  } finally { await round.close(); }
});

test('the page bundle offers what the bridge calls, and worldSeedFor names the place the protocol derives', async () => {
  for (const k of ['worldSlot', 'keyOnFreeSlot', 'worldSeedFor', 'sharedWorldOf']) assert.equal(typeof CLIENT[k], 'function', k);
  const { round, named, signerNode, rid, sharedWorld } = await contractShared(18848);
  try {
    const entry = { ...signerNode, roundId: rid, sessionPubkey: random(32) };
    const world = await worldSeedFor({ entry, round: rid, nodes: named.nodes, contract: named.round });
    assert.equal(world.slot, slotOfEntryId(entryId(entry)));
    assert.equal(world.seedWord, worldSeedWord({ entry, roundRandomness: world.randomness, contract: named.round, roundId: rid, sharedWorld }));
  } finally { await round.close(); }
});
