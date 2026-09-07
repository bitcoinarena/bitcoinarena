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
  const node = await serve(openStore(), { port: 0 });
  const watch = { inFlight: 0, worst: 0 };
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, censusHeight: 900000,
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
    assert.ok(client.dropped > 0, 'and it did not say so');
    assert.equal(client.dropped, 1200,
      'every tick past the round is counted, so a stall is visible rather than silent');
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
