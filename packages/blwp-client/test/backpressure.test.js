// WHAT A SLOW NODE DOES TO A CLIENT THAT KEEPS PUBLISHING.
//
// The game hands over five words a tick and asks for a batch every sixth and a
// mark every sixtieth. None of that waits for an answer. So the question this
// file is about is not whether a publish works - step B measured that - it is
// what happens when answers stop coming back while the ticks keep arriving.
//
// A real node with a slow handler, not a stub: the node is genuine and its
// `batch` and `checkpoint` are wrapped to take their time, which is what a
// loaded daemon or a bad link looks like from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { Client } from '../src/client.js';

// FUNDED, because these are rounds somebody paid for. A node started without
// being told who pays refuses everything now - disk is spent only on stakes
// that exist - so a test that means to play a round has to say so.
const FUNDED = { funded: () => true };

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
const rolling = (n) => Array.from({ length: n }, () => [45875, 0, 0, 0, 0]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A SLOW LINK, not a slow handler.
 *
 * The node and the client share one event loop here, so a handler that busied
 * itself would stop the client too and measure nothing. What is delayed is the
 * WIRE: every message waits `ms` before it is sent and the answer is waited
 * for as usual. That is what a bad link looks like from the client, which is
 * the side under test.
 */
function slowLink(client, ms, watch) {
  const real = client.send.bind(client);
  client.send = async (message) => {
    watch.inFlight++;
    watch.worst = Math.max(watch.worst, watch.inFlight);
    await wait(ms);
    const answer = await real(message);
    watch.inFlight--;
    return answer;
  };
}

async function rig(ms) {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const watch = { inFlight: 0, worst: 0 };
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', censusHeight: 900000,
    censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  let rid;
  try { rid = await client.openRound(c); }
  catch (e) { await node.close(); throw e; }
  const e = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  };
  let eid;
  try {
    eid = await client.join(e);
    await client.connect();
  } catch (err) { await node.close(); throw err; }
  if (ms) slowLink(client, ms, watch);
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });
  return { node, client, rid, eid, watch };
}

/**
 * THE HOLD IS BOUNDED BY THE ROUND, and the bound is not a number chosen here.
 *
 * A round is `blockTicks` long. Inputs for more ticks than the round has are
 * inputs for a round that is over, so that is the only bound that means
 * anything - and the node already refuses a batch longer than it, which is
 * where the number comes from rather than from taste.
 */
test('the hold cannot grow past the round it belongs to', async () => {
  const { node, client } = await rig(0);
  try {
    // three times the round, offered a tick at a time
    for (let i = 0; i < 1800; i++) client.record([45875, 0, 0, 0, 0]);

    assert.equal(client.held, 600, 'the hold grew past the round');
    // ONE drop, not 1200: the run ends on the first tick that will not fit,
    // rather than counting the other 1199 while publishing a chain that no
    // longer says which tick carried which input.
    assert.equal(client.dropped, 1, 'the run must end on the first dropped tick');
    assert.equal(client.ended, true);
    assert.equal(client.ending, 'VOID');
  } finally { client.close(); await node.close(); }
});

/**
 * ONE PUBLISH IN FLIGHT, so there is no queue to grow.
 *
 * The old shape appended a link to a promise chain every sixth tick whether or
 * not the one before it had finished, so a slow node grew a queue nobody was
 * watching - and the `bufferedAmount` check sat INSIDE a link, which defers
 * work without bounding anything.
 */
test('a slow node cannot make the client run two publishes at once', async () => {
  const { node, client, watch } = await rig(40);
  try {
    for (let i = 0; i < 600; i++) {
      client.record([45875, 0, 0, 0, 0]);
      if (i % 6 === 5) client.drain();          // what the game asks for
    }
    await client.settle();

    assert.equal(watch.worst, 1,
      'two batches were on the wire at once, which is a queue nobody bounds');
    assert.ok(client.batchesSent > 0, 'nothing was published at all');
  } finally { client.close(); await node.close(); }
});

/**
 * A MARK IS A MOMENT, so a late one is not worth sending.
 *
 * Ticks are the transcript and must not be dropped - unpublished inputs cannot
 * be replayed and cost the player the run. A checkpoint is the opposite: it
 * says where the world was at a tick, and one that could not go out while its
 * moment passed is not that moment any more. So it is SKIPPED and counted, not
 * queued behind the traffic, which is also what stops a slow link turning into
 * a flood of marks the moment it clears.
 */
test('marks are skipped rather than queued when one is already going', async () => {
  const { node, client } = await rig(60);
  try {
    for (let i = 1; i <= 6; i++) client.markNow('ab'.repeat(32), i * 60);
    await client.settle();

    assert.equal(client.marksSent, 1, 'more than one mark was on the wire');
    assert.equal(client.marksSkipped, 5,
      'a mark that could not go out must be counted, or a stall is invisible');
  } finally { client.close(); await node.close(); }
});

/* ------------------------------------------------------ the run has an end */

/**
 * A DROPPED TICK ENDS THE RUN INSTEAD OF MINTING A FALSE TRANSCRIPT.
 *
 * `batch` numbers a batch by a COUNT of published ticks, so from the first
 * dropped tick the chain would say 600, 601, 602 while those words are the
 * inputs from tick 1800 - a stream that reads as continuous while skipping
 * inputs, which a verifier would replay into a different world from the one
 * the player was in. That is the money-law failure, and a bound alone does not
 * prevent it: what prevents it is stopping.
 *
 * The ending is VOID - the spec's word for a fault that is not the player's.
 * Not PLAYER_LOST, because a slow node filling the hold must not become a
 * house win; not DELIVERED, because nothing was. And a player cannot use it as
 * a way out either: the round has no transcript anybody can replay, which is
 * the same answer whoever caused it.
 */
test('the first dropped tick ends the run, and nothing more is published', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    // fill the round exactly, publish it, then offer one tick too many
    for (let i = 0; i < 600; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();

    const publishedBefore = client.batchesSent;
    const firstTickBefore = client.nextTick;
    assert.equal(client.dropped, 0, 'nothing should have been dropped yet');
    assert.equal(client.ended, false);

    // the hold fills again while nothing is draining, and then overflows
    for (let i = 0; i < 601; i++) client.record([45875, 0, 0, 0, 0]);

    assert.equal(client.dropped, 1, 'exactly the tick that would not fit');
    assert.equal(client.ended, true, 'the run must end on the first dropped tick');
    assert.equal(client.ending, 'VOID');
    assert.notEqual(client.ending, 'PLAYER_LOST');
    assert.notEqual(client.ending, 'DELIVERED');
    assert.match(client.endingReason, /the hold was full at 600/);

    // and nothing leaves after it, however hard it is asked
    assert.equal(client.drain(), null, 'a batch left the client after the run ended');
    assert.equal(client.markNow('ab'.repeat(32), 1800), null, 'a mark left after the run ended');
    await client.settle();
    assert.equal(client.batchesSent, publishedBefore, 'the publish count moved after the end');
    assert.equal(client.nextTick, firstTickBefore, 'the tick numbering moved after the end');

    // the node holds the honest part and nothing beyond it
    const r = await fetch(`http://127.0.0.1:${node.port}/transcript`
      + `?round=${Buffer.from(rid).toString('hex')}&entry=${Buffer.from(eid).toString('hex')}`);
    assert.equal(Number(r.headers.get('x-ticks')), 600,
      'the node holds exactly the ticks that were honestly published');
  } finally { client.close(); await node.close(); }
});

/**
 * AND THE NUMBERS ARE CHECKED BEFORE ANYTHING LEAVES, as a second line.
 *
 * Every tick a client accepts is either published or still held, so
 * `nextTick + held` has to equal what was offered. If those part, the next
 * batch would put the wrong words at the wrong tick - so it does not go.
 */
test('a batch that would name ticks it does not carry is refused, not sent', async () => {
  const { node, client } = await rig(0);
  try {
    for (let i = 0; i < 10; i++) client.record([45875, 0, 0, 0, 0]);
    // a tick vanishes from the hold without going anywhere - the shape of any
    // bug that could lose one
    client.hold.pop();

    assert.equal(client.drain(), null, 'a mislabelled batch was allowed out');
    assert.equal(client.ended, true);
    assert.equal(client.ending, 'VOID');
    assert.match(client.endingReason, /would name ticks it does not carry/);
    assert.equal(client.batchesSent, 0);
  } finally { client.close(); await node.close(); }
});

/**
 * AND A RUN THAT NEVER DROPPED A TICK IS UNTOUCHED - the reconnect and resume
 * path still carries on at the tick the node is owed. The ending is for a
 * client that cannot be honest, not for one that had a bad connection.
 */
test('a session that dropped nothing still reconnects and carries on', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    for (let i = 0; i < 300; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();
    assert.equal(client.dropped, 0);

    client.close();
    await wait(200);
    assert.equal(client.ended, false, 'a dropped socket is not a dropped tick');

    await client.connect();
    const got = await client.resume({ roundId: rid, entryId: eid });
    assert.equal(got.nextTick, 300, 'it resumes at the tick the node is owed');

    // no setRound here: that starts a session, and this is the same one
    // carrying on. `resume` has already put the published position back.
    const before = client.batchesSent;
    for (let i = 0; i < 60; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();
    assert.equal(client.batchesSent, before + 1, 'it could not publish after the reconnect');
    assert.equal(client.ended, false, 'carrying on after a reconnect must not end the run');
    assert.equal(client.nextTick, 360, 'and it carries on at the tick it left, not from zero');
  } finally { client.close(); await node.close(); }
});

/**
 * AND THE FREEZE IS THE FREEZE, not the arithmetic guard standing in for it.
 *
 * When a tick is dropped the two checks fire together - the run ends AND the
 * numbers part - so a test on that path passes even if `drain` never looked at
 * `ended`. Measured: removing the `ended` check from `drain` left every other
 * test green. This is the case that tells them apart: a run ended for any
 * reason at all, with the hold and the counts still agreeing.
 */
test('once the run has ended, nothing leaves even though the numbers agree', async () => {
  const { node, client } = await rig(0);
  try {
    for (let i = 0; i < 10; i++) client.record([45875, 0, 0, 0, 0]);
    assert.equal(client.nextTick + client.held, client.offered, 'the counts should agree here');

    client.endRun('ended for a reason that is not a dropped tick');
    assert.equal(client.ending, 'VOID');

    assert.equal(client.drain(), null, 'a batch left a session that had ended');
    await client.settle();
    assert.equal(client.batchesSent, 0, 'the publish count moved after the end');
    assert.equal(client.held, 10, 'and what was held stayed held');
  } finally { client.close(); await node.close(); }
});
