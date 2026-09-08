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

async function rig(ms, blockTicks = 600) {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const watch = { inFlight: 0, worst: 0 };
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', censusHeight: 900000,
    censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
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

// ---------------------------------------------------------------------------
// THE RECONNECT, WHICH USED TO LIVE WHERE NOTHING COULD MEASURE IT.
//
// The loop was in `blwp.jslib` - the one file these suites cannot reach - so
// the rule that decides whether a dropped player keeps their run had no test,
// while the hold and the drain beside it had this file. Measured at 8c8c68a:
// 19 lines in the client suites mention a reconnect and every one of them
// drives `connect()` + `resume()` by hand; nothing touched the loop, its
// backoff, or the condition it stops on.
//
// The sleep is injected so the 1s/2s/4s/8s ladder can be watched in
// milliseconds. Everything else here is a real node.

/** Replaces the wait with a log of what was waited for. */
function fastSleep(client) {
  const slept = [];
  client.sleep = (ms) => { slept.push(ms); return Promise.resolve(); };
  return slept;
}

test('a reconnect keeps trying with a backoff, so a restart does not end a run', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    for (let i = 0; i < 60; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();

    // The node goes away and comes back, the way a restart looks from here.
    const port = node.port;
    await node.close();
    client.close();
    await wait(50);

    const slept = fastSleep(client);
    const back = client.reconnect({ roundId: rid, entryId: eid });
    await wait(60);
    const again = await serve(node.round.db, { port, ...FUNDED });
    try {
      const r = await back;
      assert.notEqual(r, null, 'the run was abandoned instead of resumed');
      assert.equal(r.nextTick, 60, 'it resumed at the tick the node is owed');
      assert.equal(client.ended, false, 'a restart is not a dropped tick');
      assert.ok(client.tries > 1, `one attempt was the whole of it: ${client.tries}`);
      assert.deepEqual(slept.slice(0, 4), [1000, 2000, 4000, 8000].slice(0, slept.length > 4 ? 4 : slept.length),
        'the ladder doubles');
      assert.ok(slept.every((ms) => ms <= 8000), `the backoff ran past its cap: ${slept}`);
    } finally { await again.close(); }
  } finally { client.close(); }
});

test('one reconnect is in flight however hard the drops come', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    await node.close();
    client.close();
    await wait(50);
    fastSleep(client);

    // Twenty callers, which is what a socket flapping looks like from `onDrop`.
    const many = Array.from({ length: 20 }, () => client.reconnect({ roundId: rid, entryId: eid }));
    assert.equal(new Set(many).size, 1, 'a second caller opened a second loop');

    // and it is still one after the loop has been round several times
    await wait(80);
    assert.equal(client.reconnect({ roundId: rid, entryId: eid }), client.reconnecting);

    // AND ENDING THE RUN STOPS IT. Raced for the same reason as below: a loop
    // that ignored `ended` would spin here rather than fail here.
    client.endRun('measured, so the loop can stop');
    const done = await Promise.race([
      Promise.all(many).then(() => 'stopped'),
      wait(1000).then(() => 'still trying'),
    ]);
    assert.equal(done, 'stopped', 'the loop went on after the run had ended');
    assert.equal(client.reconnecting, null, 'the loop did not let go when it finished');
  } finally {
    // PARKED, not left running. A loop that ignored `ended` would go on
    // opening sockets after the assertion above had already failed, and a
    // suite that stalls says nothing about which rule broke.
    client.ended = true;
    client.sleep = () => new Promise(() => {});
    client.close();
  }
});

/**
 * A VOID RUN STAYS VOID WHEN THE SOCKET COMES BACK.
 *
 * Measured at 8c8c68a: fill the hold, `endRun` says VOID - and `resume` then
 * answered `{ticks:6, batches:1, nextTick:6, receipts:1, live:false}` anyway.
 * The page read that as a healthy session: status `ready`, the player still
 * driving, every later tick silently discarded by `record`, and nobody told.
 * A link the operator owns had ended the run and the client showed no sign.
 */
test('after a hold-full VOID, resume refuses by name and returns no numbers', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    for (let i = 0; i < 6; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();
    for (let i = 0; i < 2000; i++) client.record([45875, 0, 0, 0, 0]);
    assert.equal(client.ended, true);
    assert.equal(client.ending, 'VOID');

    // the socket is fine - this is not about reaching the node
    await assert.rejects(
      () => client.resume({ roundId: rid, entryId: eid }),
      /this run ended VOID: .*a socket coming back does not resume it/,
      'a VOID run was handed a tick number to carry on from');

    assert.equal(client.nextTick, 6, 'and nothing moved: no tick number was invented');
    assert.equal(client.ending, 'VOID', 'and no second word was set');
  } finally { client.close(); await node.close(); }
});

test('a reconnect on an ended run does not open a socket', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    client.close();
    await wait(50);
    client.endRun('the hold filled while the socket was down');
    assert.equal(client.ending, 'VOID');

    assert.equal(client.reconnect({ roundId: rid, entryId: eid }), null,
      'a run with no honest transcript was given a live socket');
    await wait(50);
    assert.equal(client.sock, null, 'a socket was opened for a run that is over');
    assert.equal(client.tries, 0, 'it tried anyway');
  } finally { client.close(); await node.close(); }
});

/**
 * AND A RUN THAT ENDS WHILE THE LOOP IS ASLEEP STOPS THE LOOP.
 *
 * The game keeps handing over ticks through an outage, so the tick that will
 * not fit the hold ends the run in the middle of the backoff. `ended` is read
 * every time round rather than once on the way in.
 */
test('a run that ends mid-backoff is not resumed when the node returns', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    const port = node.port;
    await node.close();
    client.close();
    await wait(50);

    // The game keeps handing over ticks through the outage, so the hold fills
    // while the loop is between attempts - which is exactly where `ended` has
    // to be read again rather than once on the way in.
    client.sleep = async () => {
      for (let i = 0; i < 700; i++) client.record([45875, 0, 0, 0, 0]);
    };
    // RACED, because the failure this is about is a loop that never stops.
    // Awaiting it plainly would hang the suite instead of failing it, and a
    // run that hangs says nothing about which rule broke.
    const back = client.reconnect({ roundId: rid, entryId: eid });
    const done = await Promise.race([back, wait(1000).then(() => 'still trying')]);
    assert.equal(done, null,
      `the loop went round again after the run had ended: ${done}`);
    assert.equal(client.ending, 'VOID');
    assert.equal(client.sock, null, 'and it left no socket open behind it');

    // and the node coming back afterwards changes nothing
    const again = await serve(node.round.db, { port, ...FUNDED });
    try {
      assert.equal(client.reconnect({ roundId: rid, entryId: eid }), null);
      await wait(50);
      assert.equal(client.sock, null, 'an ended run was given a socket when the node returned');
    } finally { await again.close(); }
  } finally {
    // PARKED, not left running. A loop that ignored `ended` would go on
    // opening sockets after the assertion above had already failed, and a
    // suite that stalls says nothing about which rule broke.
    client.ended = true;
    client.sleep = () => new Promise(() => {});
    client.close();
  }
});

test('nothing is offered to a wire that is not there', async () => {
  // The page's own round length, so a 3000-tick outage fits inside it and this
  // measures the wire and not the hold bound, which has its own test below.
  const { node, client } = await rig(0, 9000);
  try {
    for (let i = 0; i < 6; i++) client.record([45875, 0, 0, 0, 0]);
    client.close();
    await wait(50);

    const sends = [];
    const real = client.send.bind(client);
    client.send = (m) => { sends.push(m.length); return real(m); };

    // 3000 ticks of outage at the page's cadence: a batch every sixth, a mark
    // every sixtieth. Measured at 8c8c68a: 550 messages handed to a socket
    // that was not there, and `held` reading up to `chunk` short the whole
    // time because the rows sat in a doomed promise.
    for (let i = 0; i < 3000; i++) {
      client.record([45875, 0, 0, 0, 0]);
      if ((i + 1) % 6 === 0) client.drain();
      if ((i + 1) % 60 === 0) client.markNow('ab'.repeat(32), i + 1);
    }
    await client.settle();

    assert.equal(sends.length, 0, `${sends.length} messages were sent with no socket`);
    assert.equal(client.held, 3006, 'the hold under-reported what it is holding');
    assert.equal(client.nextTick + client.held, client.offered, 'and the counts still agree');
    assert.equal(client.marksSkipped, 50, 'a mark that could not go out must be counted');
    assert.equal(client.ended, false, 'an outage inside the round is not an ending');
  } finally { client.close(); await node.close(); }
});

/**
 * AND THE BOUND IS STILL THE ROUND, not a number chosen for an outage. A
 * client that is down for longer than the round it is playing has inputs for a
 * round that has ended, and the first tick that will not fit is VOID.
 */
test('the hold still caps at blockTicks while the socket is down, and overflow is VOID', async () => {
  const { node, client } = await rig(0);
  try {
    client.close();
    await wait(50);
    for (let i = 0; i < 1200; i++) {
      client.record([45875, 0, 0, 0, 0]);
      if ((i + 1) % 6 === 0) client.drain();
    }
    assert.equal(client.maxHold, 600, 'the bound is the round, off the contract');
    assert.equal(client.held, 600);
    assert.equal(client.dropped, 1, 'the run must end on the first dropped tick');
    assert.equal(client.ended, true);
    assert.equal(client.ending, 'VOID');
  } finally { client.close(); await node.close(); }
});

// ---------------------------------------------------------------------------
// THE SESSION'S ONE WORD.
//
// It was the page's, in `blwp.jslib`, which is the file `node --test` cannot
// load - and that is how it came to be wrong and to survive an audit saying
// so. The page learned `ended` only when `reconnect` answered null, which is
// the socket-DOWN path; a VOID with the socket still UP left it printing
// `ready` beside the run's own ENDED VOID. Two words about one session.
//
// The word and the line are the client's now, so these are readable here.

test('a VOID with the socket still up says ended, not ready', async () => {
  const { node, client } = await rig(0);
  try {
    for (let i = 0; i < 6; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();
    assert.equal(client.state, 'ready', 'the socket is up and the run is alive');

    // The slow-node case: the hold fills and the first tick that will not fit
    // ends the run. The socket never dropped.
    let told = null;
    client.onEnd = (word, why) => { told = `${word} ${why}`; };
    for (let i = 0; i < 2000; i++) client.record([45875, 0, 0, 0, 0]);

    assert.equal(client.ended, true);
    assert.equal(client.state, 'ended', 'the word was still ready on a run that had ended');
    assert.match(told || '', /^VOID a tick was dropped at \d+/,
      'endRun must say so before the close listener returns early');

    const line = client.status(1234);
    assert.match(line, /^ended /, 'the line must open with the word the session is in');
    assert.equal(/\bready\b/.test(line), false, `ready was printed beside a VOID: ${line}`);
    assert.match(line, /VOID a tick was dropped/, 'and it must say which word and why');
  } finally { client.close(); await node.close(); }
});

test('the word follows the socket: ready, dropped, ready again', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    for (let i = 0; i < 60; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();
    await client.settle();
    assert.equal(client.state, 'ready');

    client.close();
    await wait(100);
    assert.equal(client.state, 'dropped', 'a dropped socket is not an ended run');
    assert.equal(client.ended, false);
    assert.match(client.status(60), /^dropped /);

    fastSleep(client);
    const r = await client.reconnect({ roundId: rid, entryId: eid });
    assert.notEqual(r, null);
    assert.equal(client.state, 'ready', 'a resumed run is ready again');
  } finally { client.close(); await node.close(); }
});

test('a run that ends while the socket is down ends in the word too', async () => {
  const { node, client, rid, eid } = await rig(0);
  try {
    await node.close();
    client.close();
    await wait(50);
    assert.equal(client.state, 'dropped');

    let told = 0;
    client.onEnd = () => { told++; };
    client.sleep = async () => {
      for (let i = 0; i < 700; i++) client.record([45875, 0, 0, 0, 0]);
    };
    const back = client.reconnect({ roundId: rid, entryId: eid });
    const done = await Promise.race([back, wait(1000).then(() => 'still trying')]);
    assert.equal(done, null);
    assert.equal(client.state, 'ended');
    assert.equal(told, 1, 'the ending is one event, not one per attempt');
    // The leading word, not a search: `dropped 1` further along the line is
    // the count of dropped TICKS and `drops 1` the count of dropped sockets.
    // Both are true and neither is the session's state.
    assert.equal(client.status(0).split(' ')[0], 'ended',
      `a stale word survived the ending: ${client.status(0)}`);
  } finally {
    client.ended = true;
    client.sleep = () => new Promise(() => {});
    client.close();
  }
});

test('the ending is said once, whatever else goes wrong afterwards', async () => {
  const { node, client } = await rig(0);
  try {
    let told = 0;
    client.onEnd = () => { told++; };
    client.endRun('measured');
    client.endRun('measured again');
    client.close();
    await wait(50);
    assert.equal(told, 1, 'a second ending would be a second word about one run');
    assert.equal(client.state, 'ended');
    assert.equal(client.ending, 'VOID');
  } finally { client.close(); await node.close(); }
});

/**
 * A SOCKET OPENING DOES NOT MAKE AN ENDED RUN LIVE.
 *
 * Found by a mutant that survived: removing the `ended` guard in `connect`
 * left every test green. The window is real - the game keeps handing over
 * ticks while a reconnect is in flight, so the hold can fill and end the run
 * between the socket being asked for and the socket opening. The loop's own
 * catch would put the word back a moment later, which is a moment in which a
 * panel and a game are reading `ready` on a round that cannot be settled.
 */
test('a socket that opens onto an ended run does not say ready', async () => {
  const { node, client } = await rig(0);
  try {
    client.close();
    await wait(50);
    client.endRun('the hold filled while the socket was being asked for');
    assert.equal(client.state, 'ended');

    await client.connect();
    assert.equal(client.state, 'ended', 'an open socket made an ended run look live');
    assert.equal(client.status(0).split(' ')[0], 'ended');
  } finally { client.close(); await node.close(); }
});

/**
 * A CLIENT WITH NO ROUND DOES NOT END A RUN IT NEVER BEGAN.
 *
 * Found in a browser, on the built page, and findable nowhere else: every test
 * in this file calls `setRound` before it records anything, and the game does
 * not. `Client.at` resolves three round trips before `setRound` does - open,
 * join, connect - and Unity ticks at 60 Hz through all of them, so `record`
 * ran against a client whose `maxHold` was still 0 and whose `offered` was
 * undefined. Every session VOIDed on its first tick, before a byte was
 * published: "a tick was dropped at NaN: the hold was full at 0".
 *
 * It was there before this door was and it was invisible, because nothing was
 * told and the page went on looking healthy. It shows now because a VOID stops
 * the truck.
 */
test('ticks offered before the round is known do not end the run', async () => {
  const { node, client } = await rig(0);
  try {
    // A fresh client is exactly what `Client.at` hands the page back.
    const early = new Client({ base: client.base, core, sign, verify });
    assert.equal(early.maxHold, 0, 'the constructor has no round to bound a hold by');

    for (let i = 0; i < 600; i++)
      assert.equal(early.record([45875, 0, 0, 0, 0]), false, 'a tick was taken with no round');

    // `ended` is UNDEFINED on a fresh client, not false: `setRound` is what
    // sets it, and `setRound` is exactly what has not happened yet. Asserting
    // `=== false` here failed on the truth rather than on the fault.
    assert.ok(!early.ended, 'the run ended before it had begun');
    assert.equal(early.ending, undefined, 'and a word was set for a round nobody was playing');
    // The observed corruption by name: `offered` was `undefined++`, which is
    // NaN, and that NaN is what the page printed back as the tick a run died
    // on. Untouched here, because nothing was counted at all.
    assert.equal(Number.isNaN(early.offered), false, 'the offered count went to NaN');
    assert.ok(!early.dropped, 'a tick was counted as dropped before there was a round');

    // and once it knows the round, it takes them
    early.setRound({ roundId: b32(1), entryId: b32(2), blockTicks: 600 });
    assert.equal(early.record([45875, 0, 0, 0, 0]), true);
    assert.equal(early.held, 1);
  } finally { client.close(); await node.close(); }
});
