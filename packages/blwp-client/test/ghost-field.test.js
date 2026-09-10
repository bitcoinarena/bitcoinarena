// THE PAGE'S HALF: ASK FOR THE OTHER TRUCKS, AND KEEP WHAT ARRIVES.
//
// Measured at the start of letter 28: a ghost was produced, delivered and
// decoded, and then nothing. `onGhost` had no consumer outside the tests,
// `blwp.jslib` had no ghost entry point, `GhostTruck.Show` had no caller, and
// the WebGL template shipped a 151,399-byte client that predates `watch` and
// `takeGhost` entirely. Produced, delivered, decoded - drawn by nobody.
//
// This file is the half a page can be tested on. The jslib is the one file
// `node --test` cannot load, so the rule that decides whether a player ever
// sees a competitor lives here instead of there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { watchGhosts, GHOST_BACKLOG, playersLine, newestPose } from '../src/ghost-field.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

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
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
    gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });

  // THE OTHER PLAYER, driven straight through the daemon's door: this file is
  // about what the PAGE does with what arrives.
  const theirs = {
    ...mine, playerPubkey: b32(9), sessionPubkey: b32(10), worldSecret: b32(0x59), vssSharesRef: new Uint8Array(32),
  };
  await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(theirs) });
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
    assert.deepEqual(field.drain().map((g) => g.tick), [4, 5, 6],
      'the page kept the oldest pictures and dropped the newest');
    assert.equal(field.others, 1, 'draining the renderer queue forgot who is in the round');
    assert.equal(GHOST_BACKLOG > 3, true, 'the default backlog is not a real budget');
    assert.equal(playersLine({ seated: false }), 'round named · not seated');
    assert.equal(playersLine({ seated: true, others: 0 }), '1 player · waiting');
    assert.equal(playersLine({ seated: true, others: 1 }), '2 players in this round');
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
  const shipped = readFileSync(root + 'unity-proto/Assets/WebGLTemplates/BtcLogistics/blwp-client.js');
  const built = readFileSync(root + 'packages/blwp-client/dist/blwp-client.js');
  assert.equal(shipped.length, built.length,
    `the template ships ${shipped.length} bytes and the bundle is ${built.length}`);
  assert.equal(Buffer.compare(shipped, built), 0, 'the template\'s client is not this bundle');

  // AND THE CORE THE PAGE LOADS IS THE ONE THE PACKAGES BUILD. Same class of
  // fault, found the same day: the template's `blwp-core.js` was stale, and
  // the moment anything re-bundled it the page got a core whose `HALF_X`
  // declaration the bundler had eaten - nine uses, no declaration, a throw on
  // the first step. Two copies of a built file drift; a test that compares
  // them does not.
  const shippedCore = readFileSync(root + 'unity-proto/Assets/WebGLTemplates/BtcLogistics/blwp-core.js');
  const builtCore = readFileSync(root + 'packages/core/dist/blwp-core.js');
  assert.equal(Buffer.compare(shippedCore, builtCore), 0,
    `the template ships ${shippedCore.length} bytes of core and the build is ${builtCore.length}`);

  // AND THE PAGE ASKS. `blwp.jslib` is the one file these suites cannot load,
  // so what is checked here is that it calls the module that CAN be measured -
  // not that it reimplements the rule beside it.
  const jslib = readFileSync(root + 'unity-proto/Assets/Plugins/WebGL/blwp.jslib', 'utf8');
  assert.match(jslib, /BLWPCLIENT\.watchGhosts\(net\.client, net\.where\)/,
    'the page never asks to be shown the other trucks');
  assert.equal(/onGhost\s*=/.test(jslib), false,
    'the page sets onGhost itself, so the rule for what is kept lives in the one file no test can load');

  // ONE CONSUMER OF onGhost IN THE SOURCE, and it is the measured one.
  const dir = new URL('../src/', import.meta.url).pathname;
  const sets = readdirSync(dir).filter((f) => /onGhost\s*=/.test(readFileSync(dir + f, 'utf8')));
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
 * The renderer is `GhostField.Draw(PerFrame)` calling `BlwpNextGhost`, which
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
  assert.equal(playersLine({ seated: true, others: 4 }), '5 players in this round');
  assert.equal(playersLine({ seated: true, others: 4, stalled: true }),
    '5 players in this round · none drawn');
  // A round with nobody else in it says nothing about drawing, because there
  // is nothing to draw.
  assert.equal(playersLine({ seated: true, others: 0, stalled: true }), '1 player · waiting');
  assert.equal(playersLine({ seated: false, others: 4, stalled: true }), 'round named · not seated');

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
  assert.equal(playersLine({ seated: true, others: 1, at: newestPose(held) }),
    '2 players in this round · other at -91,-71 m');
  assert.equal(playersLine({ seated: true, others: 1, stalled: true, at: newestPose(held) }),
    '2 players in this round · none drawn · other at -91,-71 m');
});

/**
 * AFTER A RELOAD THE CHIP NAMES THE LIVE OTHER, NOT A DEAD SEAT.
 *
 * Measured 2026-09-10 in two real Chromes on the Daily. A reload keeps the
 * player's key and draws a new entry, so each tab held THREE pictures: its own
 * pre-reload seat (tick 4229, -96.703,-10.200), the other player's pre-reload
 * seat (4227, -100.400,57.800) and the other player live (3041, -100.400,
 * 23.800, +30 ticks in 3 s). `newestPose` took the highest tick, and the chip
 * read "4 players in this round · other at -97,-10 m" - a frozen truck, and
 * this tab's own.
 */
const Q = 65536;
const seatPic = (entry, player, tick, x, z) => ({
  entryId: b32(entry), playerPubkey: player, tick, x: Math.round(x * Q), z: Math.round(z * Q), heading: 0,
});

test('after a reload the chip names the live other player, not the abandoned seat with more ticks', () => {
  const me = b32(0xa1);
  const them = b32(0xb2);
  const client = { watch: () => Promise.resolve('watching 3'), playerPubkey: me };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });

  // the subscribing burst, in the order it was measured
  client.onGhost(seatPic(0x20, me, 4229, -96.703, -10.2));     // this tab, before its reload
  client.onGhost(seatPic(0xc5, them, 4227, -100.4, 57.8));     // the other tab, before its reload
  client.onGhost(seatPic(0x7f, them, 3041, -100.4, 23.8));     // the other tab, live
  assert.equal(field.self, 1, 'this tab\'s own pre-reload seat was kept as somebody else');
  assert.equal(field.others, 1, `a round of two players counted ${1 + field.others}`);

  client.onGhost(seatPic(0x7f, them, 3071, -100.4, 23.8));     // and the live one moves on
  const at = newestPose(field);
  assert.equal(at.tick, 3071, `the chip named tick ${at.tick}, not the live other`);
  assert.equal(Math.round(at.x * 1000), -100400);
  assert.equal(Math.round(at.z * 1000), 23800);
  assert.equal(playersLine({ seated: true, others: field.others, at }), '2 players in this round · other at -100,24 m');
  assert.equal(field.latest().some((g) => g.tick === 4229 || g.tick === 4227), false, 'a dead seat is still held');
});

test('a dead seat that arrives after the live one is replaced by the live one\'s next picture', () => {
  const them = b32(0xb2);
  const client = { watch: () => Promise.resolve('watching 2'), playerPubkey: b32(0xa1) };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });
  client.onGhost(seatPic(0x7f, them, 3041, -100.4, 23.8));
  client.onGhost(seatPic(0xc5, them, 4227, -100.4, 57.8));     // the burst's order is the node's
  client.onGhost(seatPic(0x7f, them, 3071, -100.4, 23.8));
  assert.equal(field.others, 1);
  assert.equal(newestPose(field).tick, 3071, 'the dead seat outlived the live one\'s next picture');
});

test('two different players are still two trucks, and the newest of them is named', () => {
  const client = { watch: () => Promise.resolve('watching 2'), playerPubkey: b32(0xa1) };
  const field = watchGhosts(client, { roundId: b32(1), entryId: b32(0xc0) });
  client.onGhost(seatPic(0x11, b32(0xb2), 500, 1, 2));
  client.onGhost(seatPic(0x12, b32(0xb3), 700, 3, 4));
  assert.equal(field.others, 2, 'two players were counted as one');
  assert.equal(newestPose(field).tick, 700);
});

test('through the real client and daemon, this player\'s pre-reload seat is itself, and the other is named', async () => {
  const { node, client, rid, drive, where } = await rig();
  try {
    assert.deepEqual(client.playerPubkey, b32(5), 'join did not keep the key it seated with');
    // THIS PLAYER'S SEAT BEFORE A RELOAD: same key, another world secret, so
    // another entry - the daemon's own-entry filter does not know it is us.
    const before = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(0x55), stakeCommitment: b32(7),
      stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5d), vssSharesRef: new Uint8Array(32),
    };
    await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(before) });
    const oldSeat = entryIdOf(before);
    drive(0, 60);                          // the other player
    const head0 = node.round.head(rid, oldSeat);
    node.round.batch(encodeInputBatch({
      roundId: rid, entryId: oldSeat, previousHash: head0 || GENESIS, firstTick: 0,
      ticks: Array.from({ length: 200 }, () => [45875, 0, 0, 0, 0]), liquidations: [],
    }));                                   // the old seat ran FURTHER, as measured

    const field = watchGhosts(client, where);
    await field.watching;
    await wait(80);
    assert.ok(field.self >= 1, `the daemon pushed ${field.seen} pictures and none was this player's old seat`);
    assert.equal(field.others, 1, `a round of two players counted ${1 + field.others}`);
    const at = newestPose(field);
    assert.equal(at.tick, 59, `the chip named tick ${at.tick} - the old seat ran to 199`);
    console.log(`  real daemon: ${field.seen} pictures, ${field.self} of this player's own old seat refused, `
      + `the other named at tick ${at.tick}`);
  } finally { await node.close(); }
});
