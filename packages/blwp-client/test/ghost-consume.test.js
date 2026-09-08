// A PICTURE IS NOT AN ANSWER.
//
// The node pushes GHOSTS frames when somebody else's truck moves (letter 18,
// slice 2). This client paired EVERY message with the next request in its
// queue, so a frame arriving while a batch was in flight WAS the answer to
// that batch: the client read "the node stored N ticks" off 147 bytes of
// somebody's truck, and the real answer went to the next request, and so on
// for the rest of the run. One socket carrying both is the intended use - a
// player publishes inputs and watches competitors - so the mix-up is the
// normal case, not an edge one.
//
// This file is that case: publish and watch on ONE socket, and check both
// halves arrive where they belong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { encodeInputBatch, decodeInputBatch } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING, hash as stateHash } from '../../core/src/state.js';
import { toHex } from '../../protocol/src/hash.js';
import { TYPE_GHOST } from '../../protocol/src/constants.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixture owns this beacon exactly as the daemon's tests own theirs; the
// node still refuses to invent one, which is why it has to be given.
const BEACON = b32(0xbe);
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: BEACON, height: 900000, timeMs: 900n }) };

const wordsAt = (n) => (t) => [45875, ((t * (977 + n)) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

async function rig() {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
    settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });

  // THE OTHER IDENTITY is a second entry on the same node, driven straight
  // through the daemon's own door: this test is about what the CLIENT does
  // with what arrives, so the other player needs no client of its own.
  const theirs = {
    roundId: rid, playerPubkey: b32(9), sessionPubkey: b32(10), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x59), vssSharesRef: new Uint8Array(32),
  };
  await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(theirs) });
  const theirEid = entryIdOf(theirs);
  const words = wordsAt(9);
  let head = GENESIS;
  const drive = (first, count) => {
    const batch = {
      roundId: rid, entryId: theirEid, previousHash: head, firstTick: first,
      ticks: Array.from({ length: count }, (_, i) => words(first + i)), liquidations: [],
    };
    const bytes = encodeInputBatch(batch);
    head = node.round.head(rid, theirEid);
    node.round.batch(bytes);
    head = node.round.head(rid, theirEid);
    return bytes;
  };
  return { node, client, rid, eid, mine, theirs, theirEid, drive };
}

/** That entry's truck, from the core, under that entry's own seed. */
function drove(entry, ticks, n) {
  const st = coreInit(seedWordForEntry(entry, BEACON));
  const words = wordsAt(n);
  const at = new Map();
  for (let t = 0; t < ticks; t++) {
    coreStep(st, ...words(t));
    at.set(t, {
      x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING],
    });
  }
  return at;
}

test('a pushed ghost does not become the answer to a publish', async () => {
  const { node, client, rid, eid, theirs, theirEid, drive } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);

    // THE MIX, ARRANGED SO IT CANNOT BE A RACE. Subscribing to a round that is
    // already driving answers `watching 1` in words and then pushes one frame,
    // so by the time the next request goes out the frame is ALREADY on the
    // wire ahead of that request's reply. On the old path it was taken as that
    // reply - which is why this publish, and not the handler, is the first
    // thing measured here.
    drive(0, 120);
    assert.match(await client.watch(rid, eid), /^watching 1$/);

    for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    assert.equal(client.batchesSent, 1,
      'the publish did not get its own answer: a picture was read as the node\'s reply');
    assert.equal(client.held, 0, 'the ticks are still held, so the answer to that batch was lost');
    assert.equal(client.state, 'ready', `the run ended: ${client.why || ''}`);

    await wait(60);
    assert.equal(seen.length, 1, 'the subscribing frame did not reach the handler');

    // NOW THE MIXED CASE: publish while frames arrive on the same socket.
    // Every answer must be the node's word about that publish - a number - and
    // not a picture.
    const answers = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
      const before = client.batchesSent;
      const pushed = drive(120 + round * 40, 40);       // somebody else moves
      await client.drain();
      answers.push(client.batchesSent - before);
      assert.ok(pushed.length > 0);
      await wait(20);
    }

    assert.deepEqual(answers, [1, 1, 1, 1],
      'a publish did not get its own answer while frames were arriving');
    assert.equal(client.held, 0, 'ticks were left held, so an answer was misread');
    assert.equal(seen.length, 5, `expected five pictures, got ${seen.length}`);

    // AND THE PICTURES ARE THE OTHER IDENTITY'S, decoded, in order.
    for (const g of seen) assert.deepEqual(toHex(g.entryId), toHex(theirEid));
    assert.deepEqual(seen.map((g) => g.tick), [119, 159, 199, 239, 279]);
    assert.equal(client.ghosts, 5);

    // AND THE TRUCK IS THE CORE'S, under that entry's own seed.
    const truck = drove(theirs, 280, 9);
    for (const g of seen) {
      assert.equal(g.x, truck.get(g.tick).x, `tick ${g.tick}: x is not the core's`);
      assert.equal(g.z, truck.get(g.tick).z, `tick ${g.tick}: z is not the core's`);
      assert.equal(g.heading, truck.get(g.tick).heading, `tick ${g.tick}: heading is not the core's`);
    }
    assert.notEqual(truck.get(239).x, truck.get(279).x, 'this run does not move');
  } finally { await node.close(); }
});

test('a client that never subscribed is sent nothing, and never its own truck', async () => {
  const { node, client, rid, eid, drive } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);

    drive(0, 120);
    for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await wait(60);
    assert.equal(seen.length, 0, 'a client that never subscribed was sent a picture');
    assert.equal(client.ghosts, 0);

    // AND SUBSCRIBED, IT IS STILL NEVER SHOWN ITSELF.
    assert.match(await client.watch(rid, eid), /^watching 1$/);
    for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await wait(60);
    assert.equal(seen.some((g) => toHex(g.entryId) === toHex(eid)), false,
      'the client was sent a picture of its own truck');
    assert.equal(seen.length, 1);
  } finally { await node.close(); }
});

test('a receipt is still an answer, because the type byte says so', async () => {
  // The other binary thing a node sends back IS a reply - a receipt for a mark
  // - so routing "all bytes" to the ghost handler would lose receipts instead
  // of losing answers. The test is the type byte, and this is the case that
  // says so.
  const { node, client, rid, eid, drive } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);
    drive(0, 120);
    await client.watch(rid, eid);
    await wait(40);

    for (let i = 0; i < 60; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    const before = client.marksSent;
    const st = coreInit(7);
    // RACED, so a receipt that never comes back FAILS instead of hanging: a
    // client routing all bytes to the picture handler eats its own receipts,
    // and a test that waits forever for one reports nothing at all.
    const done = await Promise.race([
      client.markNow(stateHash(st), 60, client.head || GENESIS).then(() => 'answered'),
      wait(5000).then(() => 'never came back'),
    ]);
    assert.equal(done, 'answered', 'the receipt never came back: it was routed away from the answer queue');
    assert.equal(client.marksSent, before + 1, 'the receipt for that mark was not read as a reply');
    assert.equal(seen.length, 1, 'a receipt was routed to the ghost handler');
  } finally { await node.close(); }
});

/**
 * THE RULE ITSELF, AT THE SEAM THAT DECIDES IT.
 *
 * The end-to-end tests above show pictures arriving and publishes answered,
 * but on the OLD path a frame that arrived with no request pending was simply
 * dropped by `said.shift()` - so they went red for "the handler saw nothing"
 * rather than for the sharper thing: a frame arriving WHILE A REQUEST IS IN
 * FLIGHT was handed back as that request's answer.
 *
 * That window is the node's to open and cannot be arranged from here by
 * timing - so the frame is delivered the way the wire delivers one, as a
 * message event on the client's own socket, while a request is genuinely
 * pending. The bytes are the node's own: the frame it would have pushed.
 */
test('a picture arriving while a request is in flight is not that request\'s answer', async () => {
  const { node, client, rid, eid, theirEid, drive } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);
    drive(0, 120);
    await client.watch(rid, eid);
    await wait(40);
    // NOTHING IS ASSERTED ABOUT THE SUBSCRIBE PUSH HERE. On the old path that
    // frame was dropped, so an assertion about it would fire first and this
    // test would prove the same thing the ones above prove. What is measured
    // here is only what happens to a request that is in flight.
    const before = seen.length;

    const made = node.ghosts.latest(rid, theirEid);
    assert.equal(made.ok, true, made.why);

    // A REQUEST THE NODE ANSWERS IN WORDS, left in flight while the frame
    // lands. `close` on a round this node does not hold changes nothing and
    // comes back named.
    const pending = client.send(`close ${toHex(b32(0x77))}`);
    const copy = made.bytes.slice();
    client.sock.dispatchEvent(new MessageEvent('message', { data: copy.buffer }));

    const answer = await pending;
    assert.equal(typeof answer, 'string',
      `a picture was handed back as the answer to a request: ${answer.length} bytes`);
    assert.match(answer, /no such round/, 'that is not the answer to the request that was sent');
    assert.equal(seen.length, before + 1, 'the picture did not reach the handler');
    assert.deepEqual(toHex(seen[seen.length - 1].entryId), toHex(theirEid));
  } finally { await node.close(); }
});

test('bytes that claim to be a ghost and are not reach nobody', async () => {
  const { node, client } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);

    // The type byte says ghost and the rest is nonsense. A renderer must not
    // be handed a shape nobody decoded - it would paint a truck at whatever
    // `undefined` looks like on screen.
    const junk = new Uint8Array([TYPE_GHOST, 1, 2, 3, 4, 5]);
    client.sock.dispatchEvent(new MessageEvent('message', { data: junk.buffer }));
    await wait(20);

    assert.equal(seen.length, 0, 'a frame that does not decode was handed on anyway');
    assert.equal(client.ghosts, 0, 'it was counted as a picture');
    assert.equal(client.badGhosts, 1, 'and it was not counted as a bad one either');
  } finally { await node.close(); }
});

/**
 * A SUBSCRIPTION HAS TO SURVIVE THE SOCKET.
 *
 * The node keys its subscribers BY CONNECTION, and a reconnect is a new
 * connection - so a player who dropped for two seconds came back publishing
 * ticks and blind to everybody else for the rest of the run. No error, no
 * counter, nothing to notice: the pictures simply stopped.
 *
 * `reconnect` already re-does what a run needs - it connects and resumes - so
 * this is the third thing it has to re-do, for the same reason the other two
 * are there.
 */
test('a subscription comes back with the socket', async () => {
  const { node, client, rid, eid, theirEid, drive } = await rig();
  try {
    const seen = [];
    client.onGhost = (g) => seen.push(g);

    drive(0, 120);
    assert.match(await client.watch(rid, eid), /^watching 1$/);
    await wait(40);
    assert.equal(seen.length, 1);
    assert.equal(node.watching(), 1);

    // THE DROP: the node takes the connection away, which is what a restart
    // or a bad link does.
    for (const sock of node.wss.clients) sock.close();
    await wait(60);
    assert.equal(node.watching(), 0, 'the node kept a subscription for a socket that is gone');

    const back = await client.reconnect({ roundId: rid, entryId: eid, blockTicks: 9000 });
    assert.ok(back, 'the client did not come back');
    await wait(60);

    assert.equal(node.watching(), 1,
      'the client came back publishing and never asked to be shown anybody again');

    // AND PICTURES RESUME: the other truck moves and this player sees it.
    for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await wait(60);
    assert.equal(seen.length, 2, 'no picture arrived after the socket came back');
    assert.deepEqual(toHex(seen[1].entryId), toHex(theirEid));
  } finally { await node.close(); }
});

/**
 * A PICTURE CHANGES NOTHING THIS CLIENT PUBLISHES.
 *
 * 0.10: another player's truck is a picture, NEVER an input to my simulation.
 * Piece 1 pinned that where the core is called - `step` takes one state and
 * one player's five inputs, and a seventh argument kills the mutants that try
 * - and piece 4 pinned it in Unity, where a ghost is stripped of every
 * collider. The consume path this letter added is the third place the rule has
 * to hold, and it had no assertion of its own: a client that let a picture
 * touch its tick counter, its hold or its chain would be simulating somebody
 * else's truck in mine.
 *
 * So: two identical runs, one of them rained on with pictures, compared by
 * everything the client publishes.
 */
test('pictures change nothing this client publishes', async () => {
  const runOf = async (withPictures) => {
    const { node, client, rid, eid, theirEid, drive } = await rig();
    try {
      const seen = [];
      client.onGhost = (g) => seen.push(g);
      if (withPictures) {
        drive(0, 120);
        await client.watch(rid, eid);
        await wait(40);
      }

      // WHAT WAS PUBLISHED, as the run rather than as bytes. The two rigs get
      // their own node identity, so their contracts and therefore their round
      // and entry ids differ - comparing raw frames would compare the
      // fixture, not the run. What has to be identical is the ticks, their
      // order and the chain they were sent on.
      const sent = [];
      const real = client.send.bind(client);
      client.send = (m) => {
        if (typeof m !== 'string') {
          const b = decodeInputBatch(m);
          sent.push({
            firstTick: b.firstTick, ticks: b.ticks.map((w) => w.join(',')).join('|'),
            liquidations: JSON.stringify(b.liquidations),
            chained: toHex(b.previousHash) === toHex(GENESIS) ? 'genesis' : 'to the batch before',
          });
        }
        return real(m);
      };

      for (let i = 0; i < 200; i++) client.record([45875, ((i * 31) % 20000) - 10000, 0, 0, 0]);
      await client.drain();
      if (withPictures) { drive(120, 60); await wait(40); }
      for (let i = 0; i < 100; i++) client.record([45875, 0, 65536, 0, 0]);
      await client.drain();
      await wait(40);

      return {
        sent, pictures: seen.length,
        offered: client.offered, nextTick: client.nextTick, held: client.held,
        batchesSent: client.batchesSent, head: toHex(client.head || GENESIS),
        state: client.state, ended: client.ended,
      };
    } finally { await node.close(); }
  };

  const quiet = await runOf(false);
  const busy = await runOf(true);

  assert.equal(quiet.pictures, 0, 'the quiet run was shown pictures after all');
  assert.equal(busy.pictures > 0, true, 'the busy run was shown none, so it proves nothing');

  // THE BYTES THIS CLIENT PUT ON THE WIRE, identical: same ticks, same order,
  // same chain. If a picture had reached the simulation, a batch would carry
  // different words or a different head.
  assert.deepEqual(busy.sent, quiet.sent,
    'a picture changed what this client published');
  assert.equal(busy.offered, quiet.offered);
  assert.equal(busy.nextTick, quiet.nextTick);
  assert.equal(busy.held, quiet.held);
  assert.equal(busy.batchesSent, quiet.batchesSent);
  assert.equal(busy.head, quiet.head, 'a picture moved this run\'s input chain');
  assert.equal(busy.state, quiet.state);
  assert.equal(busy.ended, quiet.ended);
});
