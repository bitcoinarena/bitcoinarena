// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S HALF: ASK FOR THE OTHER TRUCKS, AND KEEP WHAT ARRIVES.
//
// Measured at the start of letter 28: a ghost was produced, delivered and
// decoded, and then nothing. `onGhost` had no consumer outside the tests,
// `arena.jslib` had no ghost entry point, `GhostTruck.Show` had no caller, and
// the WebGL template shipped a 151,399-byte client that predates `watch` and
// `takeGhost` entirely. Produced, delivered, decoded - drawn by nobody.
//
// This file is the half a page can be tested on. The jslib is the one file
// `node --test` cannot load, so the rule that decides whether a player ever
// sees a competitor lives here instead of there.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { watchGhosts, GHOST_BACKLOG, SILENT_MS, playersLine, newestPose } from '../../nextblock/page/ghost-field.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { encodeEntryContract, entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BEACON = b32(0xbe);
const FUNDED = {
  funded: () => true,
  randomnessFor: () => ({ hash: BEACON, height: 900005, timeMs: 900n }),
};
const words = (n) => (t) => [45875, ((t * (977 + n)) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

async function rig() {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: RUN_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  assumeStakeSeen(node.round, mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });

  // THE OTHER PLAYER, driven straight through the daemon's door: this file is
  // about what the PAGE does with what arrives.
  const theirs = {
    ...mine, playerPubkey: b32(9), sessionPubkey: b32(10), worldSecret: b32(0x59), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(theirs) });
  assumeStakeSeen(node.round, theirs);
  const theirEid = entryIdOf(theirs);
  let head = GENESIS;
  const drive = (first, count, n = 9, entry = theirEid) => {
    const batch = {
      roundId: rid, entryId: entry, previousHash: head, firstTick: first,
      ticks: Array.from({ length: count }, (_, i) => words(n)(first + i)), liquidations: [],
    };
    node.round.batch(encodeInputBatch(batch));
    head = node.round.head(rid, entry);
  };
  return { node, client, rid, eid, theirEid, drive, where: { roundId: rid, entryId: eid } };
}

test('the page asks to be shown the others, and keeps the pictures that arrive', async () => {
  const { node, client, where, theirEid, drive } = await rig();
  try {
    drive(0, 120);

    const field = watchGhosts(client, where);
    assert.match(await field.watching, /^watching \d+$/, 'the page did not subscribe');
    await wait(60);

    assert.equal(field.seen, 1, 'the subscribing push did not reach the page');
    assert.equal(field.size, 1);

    // WHAT IS KEPT IS THE OTHER TRUCK, decoded, with the words the core
    // reached - the page never sees bytes.
    const [g] = field.latest();
    assert.deepEqual(toHex(g.entryId), toHex(theirEid));
    assert.equal(g.tick, 119);
    assert.equal(Number.isInteger(g.x) && Number.isInteger(g.z) && Number.isInteger(g.heading), true,
      'the picture does not carry three integer truck words');

    // AND A DRAIN HANDS THEM ON AND EMPTIES.
    const drawn = field.drain();
    assert.equal(drawn.length, 1);
    assert.equal(field.size, 0);
    assert.deepEqual(drawn[0], g);
  } finally { await node.close(); }
});

test('a page never keeps a picture of its own truck', async () => {
  const { node, client, where, eid, drive } = await rig();
  try {
    // A REAL PICTURE FIRST, so the page is known to be keeping them at all.
    // The push comes from the daemon's socket handler, so the other player's
    // ticks are driven before the subscribe - storing them straight into the
    // round pushes nothing, which letter 18 measured.
    drive(0, 60);
    const field = watchGhosts(client, where);
    await field.watching;
    await wait(60);
    assert.equal(field.size, 1, 'the page was keeping nothing, so this proves nothing');

    // The daemon refuses to SEND a picture of your own truck (18/26). This
    // refuses to KEEP one, which is the half a page can still get wrong - and
    // the two are not the same check: "the other end will not do that" is not
    // a reason to accept it if it does.
    client.onGhost({ entryId: eid, tick: 7, x: 1, z: 2, heading: 3, playerPubkey: b32(5) });
    assert.equal(field.self, 1, 'a picture of this player\'s own truck was not counted');
    assert.equal(field.size, 1, 'a page kept a picture of the truck it is driving');
    assert.equal(field.latest().some((g) => toHex(g.entryId) === toHex(eid)), false);
  } finally { await node.close(); }
});

test('a page that cannot keep up sheds the oldest pictures, not the newest', async () => {
  const { node, client, where, drive } = await rig();
  try {
    const field = watchGhosts(client, where, { limit: 3 });
    await field.watching;

    // Six pictures into a page that holds three: piece 2 of letter 18 stated
    // for the renderer - a picture of where a truck WAS is worth less than the
    // one behind it.
    for (let tick = 1; tick <= 6; tick++)
      client.onGhost({ entryId: b32(0x77), tick, x: tick, z: 0, heading: 0, playerPubkey: b32(9) });

    assert.equal(field.seen, 6);
    assert.equal(field.size, 3, 'the page kept more than it said it would');
    assert.equal(field.shed, 3);
    // AND A DRAIN HANDS OVER THE NEWEST PICTURE OF THE TRUCK ONLY (2026-09-17 17:12: the ghost must be realtime): the
    // two older ones still queued behind it are where the truck was, and are dropped rather than drawn in turn.
    assert.deepEqual(field.drain().map((g) => g.tick), [6],
      'the page kept the oldest pictures and dropped the newest');
    assert.equal(field.collapsed, 2);
    assert.equal(field.others, 1, 'draining the renderer queue forgot who is in the round');
    assert.equal(GHOST_BACKLOG > 3, true, 'the default backlog is not a real budget');
    assert.equal(playersLine({ joined: false }), 'round named · not joined');
    assert.equal(playersLine({ joined: true, others: 0 }), '1 player · waiting');
    assert.equal(playersLine({ joined: true, others: 1 }), '2 players in this round');
  } finally { await node.close(); }
});

test('subscribing does not disturb what the client publishes', async () => {
  const { node, client, where, drive } = await rig();
  try {
    const field = watchGhosts(client, where);
    await field.watching;
    drive(0, 120);
    await wait(40);

    // The publish gets its own answer while pictures arrive - the rule letter
    // 18 measured, restated where the page now sits on top of it.
    for (let i = 0; i < 60; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    assert.equal(client.batchesSent, 1, 'a picture was read as the answer to a publish');
    assert.equal(client.held, 0);
    assert.equal(client.state, 'ready');
    assert.equal(field.size >= 1, true, 'the page was shown nothing while it published');
  } finally { await node.close(); }
});

test('a watch needs the round and the entry it is watching from', () => {
  assert.throws(() => watchGhosts(null, { roundId: b32(1), entryId: b32(2) }), /no client to watch with/);
  for (const where of [undefined, {}, { roundId: b32(1) }, { entryId: b32(2) }])
    assert.throws(() => watchGhosts({}, where), /names the round and the entry/);
});

test('the page ships the client it is written against, and one consumer of onGhost', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../../../', import.meta.url).pathname;

  // THE TEMPLATE'S COPY IS THE BUNDLE. Measured at the start of this letter:
  // the WebGL template carried a 151,399-byte client that predates `watch` and
  // `takeGhost` entirely, so the page could not have asked for a ghost even if
  // something had told it to. A copy that drifts is a page running a different
  // program from the one the suites measure.
  const shipped = readFileSync(root + 'src/arena-ui/arena-client.js');
  const built = readFileSync(root + 'packages/arena-client/dist/arena-client.js');
  assert.equal(shipped.length, built.length,
    `the template ships ${shipped.length} bytes and the bundle is ${built.length}`);
  assert.equal(Buffer.compare(shipped, built), 0, 'the template\'s client is not this bundle');

  // AND THE CORE THE PAGE LOADS IS THE ONE THE PACKAGES BUILD. Same class of
  // fault, found the same day: the template's `blwp-core.js` was stale, and
  // the moment anything re-bundled it the page got a core whose `HALF_X`
  // declaration the bundler had eaten - nine uses, no declaration, a throw on
  // the first step. Two copies of a built file drift; a test that compares
  // them does not.
  const shippedCore = readFileSync(root + 'src/arena-ui/blwp-core.js');
  const builtCore = readFileSync(root + 'packages/nextblock/dist/blwp-core.js');
  assert.equal(Buffer.compare(shippedCore, builtCore), 0,
    `the template ships ${shippedCore.length} bytes of core and the build is ${builtCore.length}`);

  // AND THE PAGE ASKS. `arena.jslib` is the one file these suites cannot load,
  // so what is checked here is that it calls the module that CAN be measured -
  // not that it reimplements the rule beside it.
  const jslib = readFileSync(root + 'unity-proto/Assets/Plugins/WebGL/arena.jslib', 'utf8');
  assert.match(jslib, /BLWPCLIENT\.watchGhosts\(net\.client, net\.where\)/,
    'the page never asks to be shown the other trucks');
  assert.equal(/onGhost\s*=/.test(jslib), false,
    'the page sets onGhost itself, so the rule for what is kept lives in the one file no test can load');

  // AND EVERYTHING THE PAGE CALLS IS IN THE BUNDLE'S EXPORTS. `tools/bundle.js` writes that list by hand, so a new
  // function can be in the file and not on the table: measured while wiring the ghost label (2026-09-17 19:15),
  // `BLWPCLIENT.tickClock` was undefined in the page although `tickClock` was bundled. The page would have carried a
  // label that never appeared, and nothing but a browser would have said so.
  const exported = new Set(Object.keys(await import(root + 'packages/arena-client/dist/arena-client.js')
    .then(() => ({})).catch(() => ({}))));
  const { createRequire: requireFrom } = await import('node:module');
  // AS THE PAGE HAS IT: the engine's bundle, then Tick Tock's ghost page, which puts the ghosts on it (§0A.2, kanban #525)
  const window = { BLWPCLIENT: { ...requireFrom(import.meta.url)(root + 'packages/arena-client/dist/arena-client.js') } };
  new Function('window', readFileSync(root + 'packages/nextblock/page/ghost-page.js', 'utf8'))(window);
  const bundle = window.BLWPCLIENT;
  for (const name of new Set([...jslib.matchAll(/BLWPCLIENT\.([A-Za-z0-9_]+)/g)].map((m) => m[1])))
    assert.ok(bundle[name] !== undefined || exported.has(name),
      `arena.jslib calls BLWPCLIENT.${name} and neither the bundle nor Tick Tock's ghost page puts it there`);

  // ONE CONSUMER OF onGhost IN THE SOURCE, and it is the measured one.
  // the client's source and Tick Tock's page part (packages/nextblock/page, where the field lives since kanban #521)
  const dirs = [new URL('../src/', import.meta.url).pathname, new URL('../../nextblock/page/', import.meta.url).pathname];
  // (ghost-page.js is the build of ghost-field.js - ghost-page.test holds it to that - so it is not a second consumer)
  const sets = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f !== 'ghost-page.js' && /onGhost\s*=/.test(readFileSync(dir + f, 'utf8'))));
  assert.deepEqual(sets.sort(), ['client.js', 'ghost-field.js'],
    'onGhost is declared or set somewhere other than the client and the field');
});

/**
 * A FIELD FILLING WITH PICTURES NOBODY DRAWS.
 *
 * The 11:51 two-Chrome retest: the chip said five players and the screen
 * showed one truck. `others` counts trucks in the round whether or not
 * anything is drawing them, so the page could not tell "nobody is here" from
 * "nobody is drawing" - and those are different faults with different fixes.
 * The renderer is `GhostField.Draw(PerFrame)` calling `ArenaNextGhost`, which
 * is the one hop `node --test` cannot reach; this is the number that would
 * have named it from the page.
 */
test('a field that is sent trucks and never drained says nobody is drawing', () => {
  const mine = b32(9);
  const client = { watch: () => Promise.resolve('watching 1') };
  const field = watchGhosts(client, { roundId: b32(1), entryId: mine });
  const ghost = (n, tick, x) => ({ entryId: b32(n), tick, x, z: 0, heading: 0 });

  assert.equal(field.stalled, false, 'a field nobody has sent anything is not stalled');

  client.onGhost(ghost(2, 5, 100));
  client.onGhost(ghost(3, 5, 200));
  assert.equal(field.others, 2, 'the round has two other trucks');
  assert.equal(field.drawn, 0);
  assert.equal(field.stalled, true, 'pictures arrived and nothing took them');

  // ONE FRAME OF A WORKING PAGE CLEARS IT. `Draw(PerFrame)` runs every frame,
  // so a renderer that is wired at all drains within a frame.
  assert.equal(field.drain(24).length, 2);
  assert.equal(field.drawn, 2);
  assert.equal(field.stalled, false);
  assert.equal(field.others, 2, 'drawing a truck does not take it out of the round');
});

test('a viewer\'s own pictures do not make the field look stalled', () => {
  // The field drops the viewer's own truck before the queue, so a page that is
  // shown only itself has taken nothing and has nothing to take. Counting that
  // as stalled would put a fault on the chip of every solo round.
  const mine = b32(9);
  const client = { watch: () => Promise.resolve('watching 0') };
  const field = watchGhosts(client, { roundId: b32(1), entryId: mine });
  client.onGhost({ entryId: mine, tick: 5, x: 1, z: 2, heading: 3 });
  assert.equal(field.self, 1);
  assert.equal(field.others, 0);
  assert.equal(field.stalled, false, 'a solo page was called stalled');
});

test('the players line says when trucks are arriving and none are drawn', () => {
  assert.equal(playersLine({ joined: true, others: 4 }), '5 players in this round');
  assert.equal(playersLine({ joined: true, others: 4, stalled: true }),
    '5 players in this round · none drawn');
  // A round with nobody else in it says nothing about drawing, because there
  // is nothing to draw.
  assert.equal(playersLine({ joined: true, others: 0, stalled: true }), '1 player · waiting');
  assert.equal(playersLine({ joined: false, others: 4, stalled: true }), 'round named · not joined');

  // AND WHERE THE NEWEST OTHER TRUCK IS, because `none drawn` only separates
  // a renderer that never ran from one that ran. A truck drawn 100 m down the
  // frontage - which is what a different loading bay is - looks through a
  // windscreen exactly like a truck that was never drawn.
  // NEWEST FIRST AND LAST IS OLDEST, so "the last one in the list" and "the
  // newest one" are different answers and only one of them passes.
  const seen = [
    { entryId: b32(2), x: -5963776, z: -4653056, heading: 0, tick: 40 },
    { entryId: b32(3), x: 0, z: 0, heading: 0, tick: 40 - 1 },
    { entryId: b32(1), x: -6579814, z: 668467, heading: 16384, tick: 10 },
  ];
  const held = { latest: () => seen };
  assert.deepEqual(newestPose(held), { x: -91, z: -71, tick: 40 },
    'the page named a pose that is not the newest one it holds');
  // A TIE IS FREE. Two trucks whose newest picture is the same tick are two
  // right answers, and which one the line names is not a fact anybody reads -
  // so what is pinned is the TICK, not the truck.
  const tied = { latest: () => [seen[0], { ...seen[1], tick: seen[0].tick }] };
  assert.equal(newestPose(tied).tick, seen[0].tick, 'the named pose is not at the newest tick');
  assert.equal(newestPose({ latest: () => [] }), null, 'an empty field named a place');
  assert.equal(newestPose(null), null, 'a page with no field named a place');
  assert.equal(playersLine({ joined: true, others: 1, at: newestPose(held) }),
    '2 players in this round · other at -91,-71 m');
  assert.equal(playersLine({ joined: true, others: 1, stalled: true, at: newestPose(held) }),
    '2 players in this round · none drawn · other at -91,-71 m');
});

/**
 * AFTER A RELOAD THE CHIP NAMES THE LIVE OTHER, NOT A DEAD ENTRY.
 *
 * Measured 2026-09-10 in two real Chromes on the Daily. A reload keeps the
 * player's key and draws a new entry, so each tab held THREE pictures: its own
 * pre-reload entry (tick 4229, -96.703,-10.200), the other player's pre-reload
 * entry (4227, -100.400,57.800) and the other player live (3041, -100.400,
 * 23.800, +30 ticks in 3 s). `newestPose` took the highest tick, and the chip
 * read "4 players in this round · other at -97,-10 m" - a frozen truck, and
 * this tab's own.
 */
const Q = 65536;
const entryPic = (entry, player, tick, x, z) => ({
  entryId: b32(entry), playerPubkey: player, tick, x: Math.round(x * Q), z: Math.round(z * Q), heading: 0,
});

test('after a reload the chip names the live other player, not the abandoned entry with more ticks', () => {
  const me = b32(0xa1);
  const them = b32(0xb2);
  const client = { watch: () => Promise.resolve('watching 3'), playerPubkey: me };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });

  // the subscribing burst, in the order it was measured
  client.onGhost(entryPic(0x20, me, 4229, -96.703, -10.2));     // this tab, before its reload
  client.onGhost(entryPic(0xc5, them, 4227, -100.4, 57.8));     // the other tab, before its reload
  client.onGhost(entryPic(0x7f, them, 3041, -100.4, 23.8));     // the other tab, live
  assert.equal(field.self, 1, 'this tab\'s own pre-reload entry was kept as somebody else');
  assert.equal(field.others, 1, `a round of two players counted ${1 + field.others}`);

  client.onGhost(entryPic(0x7f, them, 3071, -100.4, 23.8));     // and the live one moves on
  const at = newestPose(field);
  assert.equal(at.tick, 3071, `the chip named tick ${at.tick}, not the live other`);
  assert.equal(Math.round(at.x * 1000), -100400);
  assert.equal(Math.round(at.z * 1000), 23800);
  assert.equal(playersLine({ joined: true, others: field.others, at }), '2 players in this round · other at -100,24 m');
  assert.equal(field.latest().some((g) => g.tick === 4229 || g.tick === 4227), false, 'a dead entry is still held');
});

test('a dead entry that arrives after the live one is replaced by the live one\'s next picture', () => {
  const them = b32(0xb2);
  const client = { watch: () => Promise.resolve('watching 2'), playerPubkey: b32(0xa1) };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });
  client.onGhost(entryPic(0x7f, them, 3041, -100.4, 23.8));
  client.onGhost(entryPic(0xc5, them, 4227, -100.4, 57.8));     // the burst's order is the node's
  client.onGhost(entryPic(0x7f, them, 3071, -100.4, 23.8));
  assert.equal(field.others, 1);
  assert.equal(newestPose(field).tick, 3071, 'the dead entry outlived the live one\'s next picture');
});

test('two different players are still two trucks, and the newest of them is named', () => {
  const client = { watch: () => Promise.resolve('watching 2'), playerPubkey: b32(0xa1) };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });
  client.onGhost(entryPic(0x11, b32(0xb2), 500, 1, 2));
  client.onGhost(entryPic(0x12, b32(0xb3), 700, 3, 4));
  assert.equal(field.others, 2, 'two players were counted as one');
  assert.equal(newestPose(field).tick, 700);
});

test('through the real client and daemon, this player\'s pre-reload entry is itself, and the other is named', async () => {
  const { node, client, rid, drive, where } = await rig();
  try {
    assert.deepEqual(client.playerPubkey, b32(5), 'join did not keep the key it joined with');
    // THIS PLAYER'S ENTRY BEFORE A RELOAD: same key, another world secret, so
    // another entry - the daemon's own-entry filter does not know it is us.
    const before = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(0x55), stakeCommitment: b32(7),
      stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5d), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(before) });
    assumeStakeSeen(node.round, before);
    const oldSignerNode = entryIdOf(before);
    drive(0, 60);                          // the other player
    const head0 = node.round.head(rid, oldSignerNode);
    node.round.batch(encodeInputBatch({
      roundId: rid, entryId: oldSignerNode, previousHash: head0 || GENESIS, firstTick: 0,
      ticks: Array.from({ length: 200 }, () => [45875, 0, 0, 0, 0]), liquidations: [],
    }));                                   // the old entry ran FURTHER, as measured

    const field = watchGhosts(client, where);
    await field.watching;
    await wait(80);
    assert.ok(field.self >= 1, `the daemon pushed ${field.seen} pictures and none was this player's old entry`);
    assert.equal(field.others, 1, `a round of two players counted ${1 + field.others}`);
    const at = newestPose(field);
    assert.equal(at.tick, 59, `the chip named tick ${at.tick} - the old entry ran to 199`);
    console.log(`  real daemon: ${field.seen} pictures, ${field.self} of this player's own old entry refused, `
      + `the other named at tick ${at.tick}`);
  } finally { await node.close(); }
});

/* ------------------------------------------------ what Unity is left holding */

import { RETIRE_TICK } from '../../nextblock/page/ghost-field.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
// THE CORE'S OWN RUN LENGTH: `Round.open` refuses a contract naming another, and this fixture still said
// 9000, so every test here that stands up a real daemon died before it could watch anything.
import { BLOCK_TICKS as RUN_TICKS } from '../../nextblock/src/rules/gate.js';

/**
 * WHAT `GhostField.Show` DOES WITH EACH DRAINED ITEM: make or move one truck per
 * entry, and take one away on a tick below zero. Replayed here so the page's
 * rule is measured by the trucks it leaves Unity holding.
 *
 * Measured 2026-09-10 on the Daily, before this: a reload handed Unity 9 and 11
 * entries, 8 and 10 of them abandoned (one picture each, frozen), and a watched
 * player's reload left its 105-picture entry frozen beside the new one.
 */
const render = (trucks, items) => {
  for (const g of items) {
    const s = toHex(g.entryId);
    if (g.tick < 0) trucks.delete(s); else trucks.set(s, g);
  }
  return trucks;
};
const watcher = (me = b32(0xa1)) => {
  const client = { watch: () => Promise.resolve('watching'), playerPubkey: me };
  return { client, field: watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) }) };
};

test('after a reload the abandoned entries never stand in Unity: the measured 8 leave 0 trucks', () => {
  assert.equal(RETIRE_TICK < 0, true, 'a retire must be a tick no picture can carry');
  const them = b32(0xb2);
  const { client, field } = watcher();
  const trucks = new Map();
  // the subscribing burst as P1 measured it: eight abandoned entries, one picture each, then the live one
  [5315, 173, 5309, 5579, 8993, 173, 125, 4227].forEach((t, i) => client.onGhost(entryPic(0x30 + i, them, t, -100.4, i)));
  client.onGhost(entryPic(0x7f, them, 29, -100.4, -44.2));
  render(trucks, field.drain());
  for (let t = 35; t <= 149; t += 6) client.onGhost(entryPic(0x7f, them, t, -100.4, -44.2));
  render(trucks, field.drain());
  assert.deepEqual([...trucks.keys()], [toHex(b32(0x7f))], `Unity is left holding ${trucks.size} trucks`);
  assert.equal(field.retired, 8);
  console.log(`  burst of 8 abandoned entries and the live one: Unity holds ${trucks.size} truck, ${field.retired} retired`);
});

test('a watched player who reloads leaves no truck behind: the old entry goes when the new one proves live', () => {
  const them = b32(0xb2);
  const { client, field } = watcher();
  const trucks = new Map();
  for (let t = 5; t < 5 + 105 * 8; t += 8) client.onGhost(entryPic(0xe3, them, t, -100.4, 30.6));   // 105 pictures
  render(trucks, field.drain());
  client.onGhost(entryPic(0xaf, them, 5, -100.4, -37.4));      // the reloaded entry's first picture
  assert.equal(field.superseded, 1, 'the new entry\'s first picture was drawn while the old entry was live');
  assert.equal(field.retired, 0, 'the live entry was retired on one picture of another');
  client.onGhost(entryPic(0xaf, them, 11, -100.4, -37.4));     // ... and its second: now it is the live one
  render(trucks, field.drain());
  assert.deepEqual([...trucks.keys()], [toHex(b32(0xaf))], `Unity is left holding ${trucks.size} trucks`);
  assert.equal(field.retired, 1);
});

test('an abandoned entry arriving after the live one is proven never reaches Unity', () => {
  const them = b32(0xb2);
  const { client, field } = watcher();
  client.onGhost(entryPic(0x7f, them, 29, -100.4, -44.2));
  client.onGhost(entryPic(0x7f, them, 35, -100.4, -44.2));
  client.onGhost(entryPic(0xc5, them, 4227, -100.4, 57.8));    // one picture, frozen
  const items = field.drain();
  assert.equal(items.some((g) => toHex(g.entryId) === toHex(b32(0xc5))), false, 'the abandoned entry reached Unity');
  assert.deepEqual([...render(new Map(), items).keys()], [toHex(b32(0x7f))]);
  assert.equal(field.superseded, 1);
});

test('a player whose only entry has finished keeps their truck: one picture alone is not an abandoned entry', () => {
  const { client, field } = watcher();
  client.onGhost(entryPic(0x44, b32(0xd4), 9000, -20, 110));
  assert.deepEqual([...render(new Map(), field.drain()).keys()], [toHex(b32(0x44))]);
  assert.equal(field.retired, 0);
});

test('two players are two trucks in Unity, not one', () => {
  const { client, field } = watcher();
  client.onGhost(entryPic(0x11, b32(0xb2), 500, 1, 2));
  client.onGhost(entryPic(0x12, b32(0xb3), 700, 3, 4));
  client.onGhost(entryPic(0x11, b32(0xb2), 506, 1, 2));
  client.onGhost(entryPic(0x12, b32(0xb3), 706, 3, 4));
  assert.equal(render(new Map(), field.drain()).size, 2);
  assert.equal(field.retired, 0);
});

test('a retire is never shed from a full queue, or that truck would stand for good', () => {
  const client = { watch: () => Promise.resolve('watching'), playerPubkey: b32(0xa1) };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) }, { limit: 3 });
  client.onGhost(entryPic(0x21, b32(0xb2), 10, 0, 0));      // a one-picture entry ...
  client.onGhost(entryPic(0x22, b32(0xb2), 20, 0, 0));      // ... superseded by another: a retire is queued
  for (let t = 1; t <= 10; t++) client.onGhost(entryPic(0x33, b32(0xb3), t, 0, 0));   // and a flood behind it
  const items = field.drain();
  // the retire, and at most the newest picture of each truck (17:12: realtime, no backlog)
  assert.ok(items.length >= 2 && items.length <= 3, `${items.length} items`);
  const pics = items.filter((g) => !g.retire).map((g) => toHex(g.entryId));
  assert.equal(new Set(pics).size, pics.length, 'two pictures of one truck were handed over');
  assert.ok(items.some((g) => g.tick < 0 && toHex(g.entryId) === toHex(b32(0x21))), 'the retire was shed');
  assert.ok(field.shed > 0, 'nothing was shed, so this proves nothing');
});

test('through a real daemon\'s subscribe burst, the other player\'s abandoned entries leave no truck in Unity', async () => {
  const { node, client, rid, drive, where, theirEid } = await rig();
  try {
    // THE OTHER PLAYER'S ABANDONED ENTRIES: the same key, other world secrets, so
    // other entries - each with a run of its own that then stops, as a reload
    // leaves one. The daemon sends the latest picture of every entry on watch.
    const abandoned = [0x61, 0x62, 0x63].map((w) => ({
      roundId: rid, playerPubkey: b32(9), sessionPubkey: b32(w), stakeCommitment: b32(7),
      stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: b32(w), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    }));
    for (const entryKey of abandoned) {
      await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entryKey) });
      assumeStakeSeen(node.round, entryKey);
      node.round.batch(encodeInputBatch({
        roundId: rid, entryId: entryIdOf(entryKey), previousHash: GENESIS, firstTick: 0,
        ticks: Array.from({ length: 40 }, (_, i) => words(9)(i)), liquidations: [],
      }));
    }
    drive(0, 60);                                   // the live entry, before the watch

    const field = watchGhosts(client, where);
    await field.watching;
    await wait(80);
    // AND IT MOVES ON, SENT THE WAY THE PAGE SENDS IT: over the /play socket.
    // `drive` stores straight into the round, which pushes nothing to anyone.
    const { WebSocket } = await import('ws');
    const sock = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
    await new Promise((r) => sock.on('open', r));
    const answered = new Promise((r) => sock.once('message', r));
    sock.send(encodeInputBatch({
      roundId: rid, entryId: theirEid, previousHash: node.round.head(rid, theirEid), firstTick: 60,
      ticks: Array.from({ length: 30 }, (_, i) => words(9)(60 + i)), liquidations: [],
    }));
    await answered;
    await wait(120);
    sock.close();

    const trucks = render(new Map(), field.drain());
    console.log(`  real daemon: ${field.seen} pictures, ${field.retired} retired, ${field.superseded} held back, `
      + `Unity left holding ${trucks.size}`);
    assert.deepEqual([...trucks.keys()], [toHex(theirEid)],
      `Unity is left holding ${trucks.size} trucks: ${[...trucks.keys()].map((k) => k.slice(0, 8)).join(', ')}`);
  } finally { await node.close(); }
});

test('a truck of a round that is over goes, and one of a live round stays through any silence', () => {
  // 2026-09-18 12:02: "after 2nd round Truck 1 cannot see Truck 2. Age 6736ms on young-hawk-9551". Measured on
  // the Daily with a watcher that kept its field across two round boundaries: it carried one truck of the round it had
  // left into each new round, and of the new round it received nothing at all - first picture NEVER, superseded 0,
  // pictures of a left round 0. Until 0.0.1591 the three-second silence took that truck away; nothing else ever did,
  // so since then it stands for ever with its age climbing, which is the label in the shot.
  const client = { watch: () => Promise.resolve('watching'), playerPubkey: b32(0xa1), ended: false, runOver: () => false };
  let clock = 1000000;
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) }, { clock: () => clock });
  for (let t = 1; t <= 20; t++) client.onGhost(entryPic(0x51, b32(0xe1), t, t * 65536, 0));
  assert.equal(field.drain(24, clock).length, 1, 'the other truck was not drawn at all');
  assert.equal(field.others, 1);

  // A LIVE ROUND KEEPS ITS TRUCK through a silence far past the old retire age - that is the 10:42 rule.
  clock += 9000;
  assert.deepEqual(field.drain(24, clock).filter((g) => g.retire), [], 'a live round took a quiet truck away');
  assert.equal(field.others, 1, 'a live round dropped its quiet truck');
  assert.equal(field.roundEnded, 0);

  // AND WHEN THIS PAGE'S OWN RUN IS OVER, the truck goes: no picture of that round can arrive again.
  client.runOver = () => true;
  const after = field.drain(24, clock);
  assert.deepEqual(after.filter((g) => g.retire).map((g) => toHex(g.entryId).slice(0, 2)), ['51'],
    'the truck of a finished round was left standing, which is the 6736 ms label in the shot');
  assert.equal(field.others, 0, 'the finished round left a truck on the field');
  assert.equal(field.roundEnded, 1);
  // AND ONLY ONCE: a drain after that says nothing more about it.
  assert.deepEqual(field.drain(24, clock + 1000).filter((g) => g.retire), [], 'the retire was sent twice');
});

test('realtime: a page that fell behind draws each truck at its newest picture, and a quiet truck stays where it stood', () => {
  // 2026-09-17 17:05 / 17:12: the ghost stood where the other player had been a minute before, and after the next
  // round old trucks stayed. A drain hands over the newest picture per truck.
  //
  // AND A SILENCE NO LONGER TAKES A TRUCK AWAY (2026-09-18 10:42, the missing-then-wrong-place shot). Measured
  // on the Daily that hour: 5231 pictures, gaps to 5131 ms, nine over three seconds - each one retired a truck and the
  // next picture drew it again metres away, while the pose itself was never behind by more than 3 ticks at the
  // ninetieth. A stall is the signer nodes, not a player leaving.
  const client = { watch: () => Promise.resolve('watching'), playerPubkey: b32(0xa1) };
  let clock = 1000000;
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) }, { clock: () => clock });
  for (let t = 1; t <= 200; t++) {           // twenty seconds of two trucks nobody drew (a paused tab)
    client.onGhost(entryPic(0x41, b32(0xd1), t, t * 65536, 0));
    client.onGhost(entryPic(0x42, b32(0xd2), t, 0, t * 65536));
  }
  const now = clock;
  const first = field.drain(24, now);
  assert.deepEqual(first.map((g) => [toHex(g.entryId).slice(0, 2), g.tick]).sort(), [['41', 200], ['42', 200]],
    'the first frame after the pause did not put both trucks at their newest picture');
  assert.equal(field.size, 0, 'a backlog was left to replay');
  assert.equal(field.drain(24, now + 1000).length, 0);
  // one truck keeps sending, the other has stopped: THREE SECONDS of silence, the old retire age.
  clock = now + SILENT_MS;
  client.onGhost(entryPic(0x41, b32(0xd1), 201, 0, 0));
  const later = field.drain(24, now + SILENT_MS + 500);
  assert.deepEqual(later.filter((g) => g.retire).map((g) => toHex(g.entryId).slice(0, 2)), [],
    'a truck was taken off the screen for three seconds of silence: that is the missing-then-wrong-place shot');
  assert.ok(later.some((g) => !g.retire && toHex(g.entryId).startsWith('41') && g.tick === 201), 'the live truck was not drawn');
  assert.equal(field.silenced, 1, 'the quiet truck is not counted as quiet');
  assert.equal(field.others, 2, 'the quiet truck left the field instead of standing where its last picture put it');

  // AND FIVE SECONDS, which is the worst gap measured on the Daily that day.
  const five = field.drain(24, now + 5000);
  assert.deepEqual(five.filter((g) => g.retire), [], 'five seconds of silence took the truck away');
  assert.equal(field.others, 2, 'the truck went after five seconds of silence');

  // AND WHEN A FRESH PICTURE COMES, the truck moves to it - no retire in between, so nothing vanishes and reappears.
  client.onGhost(entryPic(0x42, b32(0xd2), 260, 9 * 65536, 0));
  const back = field.drain(24, now + 5200);
  assert.equal(back.filter((g) => g.retire).length, 0, 'the truck was retired on the way back');
  assert.ok(back.some((g) => toHex(g.entryId).startsWith('42') && g.tick === 260), 'the quiet truck did not take its new picture');

  // WHAT STILL TAKES A TRUCK AWAY is the page knowing it is gone: the player's next entry supersedes this one.
  for (let t = 1; t <= 3; t++) client.onGhost(entryPic(0x43, b32(0xd2), t, 0, 0));
  const swapped = field.drain(24, now + 5400);
  assert.ok(swapped.some((g) => g.retire && toHex(g.entryId).startsWith('42')),
    'a player who came back under a new entry left their old truck standing');
});
