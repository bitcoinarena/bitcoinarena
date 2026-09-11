// A CLIENT WHOSE BATCHES THE NODE WILL NOT TAKE, AND WHAT THAT LOOKS LIKE FROM
// EVERY OTHER TAB IN THE ROUND.
//
// Measured before this file: a refused batch put its words back at the head of
// the hold and changed nothing else, so the very next `drain` sent the SAME
// batch. A node refusing for a reason that does not go away was asked the same
// question for the rest of the round, and from outside the run looked healthy -
// the socket up, the player driving, the player count right. What it had lost
// was `nextTick`, which never moved again, and with it every watcher's picture
// of that truck: a ghost frozen at the last tick that landed while its driver
// was somewhere else entirely.
//
// That is the 16:08 two-Chrome close-out of letter 36, from the other side:
// P1 in the field on fire, P2's ghost still at P1's bay, tick stuck at 4241,
// chip reading play and two players the whole time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { playersLine } from '../src/ghost-field.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeStakeSeen } from '../../blwp-node/test/seating.js';
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const FUNDED = { funded: () => true };
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rig() {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
    settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
  };
  const eid = await client.join(entry);
  assumeStakeSeen(node.round, entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });
  return { node, client, rid, eid };
}

/** Drive `n` ticks and let every publish that can go out, go out. */
async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([45875, 22000, 0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* the refusal is the measurement */ } }
    await wait(2);
    if (!client.hold.length || client.ended) break;
  }
}

test('a run publishes, and while it publishes nothing is refused', async () => {
  const { node, client } = await rig();
  try {
    await drive(client, 120);
    assert.ok(client.nextTick >= 120, `the node was owed ${client.nextTick} after 120 ticks`);
    assert.equal(client.refusals, 0);
    assert.equal(client.refusedWhy, null);
    assert.equal(client.ended, false);
  } finally { client.close(); await node.close(); }
});

/**
 * THE ONE THE 16:08 REPORT WAS: the node refuses, and it goes on refusing.
 *
 * The node here is real and its `batch` is wrapped to say no from a tick
 * onwards - which is what "expected tick N, got M" and "the batch does not
 * follow the chain head" both look like from the client, and neither of those
 * fixes itself.
 */
test('a node that keeps refusing ends the run by name instead of being asked forever', async () => {
  const { node, client } = await rig();
  try {
    await drive(client, 60);
    const landed = client.nextTick;
    assert.ok(landed >= 60, 'nothing landed before the refusals started');

    let asked = 0;
    const real = node.round.batch.bind(node.round);
    node.round.batch = (bytes) => { asked++; throw new Error('expected tick 4242, got 4300'); };

    await drive(client, 300);

    // THE RUN IS OVER, AND IT SAYS WHY IN THE NODE'S OWN WORDS.
    assert.equal(client.ended, true, 'the client is still asking a node that will not answer yes');
    assert.equal(client.ending, 'VOID');
    assert.match(client.endingReason, /refuses this run's inputs/);
    assert.match(client.endingReason, /expected tick 4242, got 4300/);

    // AND IT DID NOT SPIN. One refusal, one resync, one more refusal, done -
    // not three hundred ticks' worth of the same batch.
    assert.ok(asked <= 4, `the client asked a refusing node ${asked} times`);
    assert.ok(client.refusals <= 3, `${client.refusals} refusals is a client that kept trying`);

    // AND THE TICK IT DIED AT IS THE LAST ONE THAT LANDED, which is exactly
    // where every watcher's picture of this truck stops.
    assert.equal(client.nextTick, landed, 'the run ended somewhere other than where it stopped publishing');
    node.round.batch = real;
  } finally { client.close(); await node.close(); }
});

/**
 * AND A REFUSAL THAT WAS ABOUT THE NUMBERS IS SURVIVED.
 *
 * A node and a client can disagree about where a run is - a reconnect, a
 * batch that landed after the answer was lost - and that is not a dead run.
 * One refusal re-reads the two numbers off the node and the run carries on.
 */
test('a run whose numbers drifted resyncs once and keeps publishing', async () => {
  const { node, client } = await rig();
  try {
    await drive(client, 60);
    const landed = client.nextTick;

    // The client's idea of the next tick is moved forward by hand, which is
    // what a lost answer leaves behind. Every batch it builds from here names
    // ticks the node is not owed.
    client.nextTick = landed + 25;
    client.offered = client.nextTick + client.hold.length;

    await drive(client, 120);

    assert.equal(client.ended, false,
      `the run ended on a disagreement the numbers could fix: ${client.endingReason}`);
    assert.ok(client.refusals >= 1, 'the fixture did not actually produce a refusal');
    assert.ok(client.nextTick > landed, 'the run never published again after resyncing');
    assert.equal(client.refusedWhy, null, 'a run that recovered still reports a refusal');
  } finally { client.close(); await node.close(); }
});

/**
 * AND THE PAGE HAS A LINE FOR IT, which is the number the two Chromes did not
 * have. Everything else on that chip was right while the run was dead.
 */
test('the chip says a tab is not publishing, above everything else it could say', () => {
  assert.equal(
    playersLine({ seated: true, others: 1, at: { x: -100, z: -37 }, refused: 'expected tick 4242, got 4300' }),
    'not publishing · expected tick 4242, got 4300');
  // and a healthy tab still reads the way it did
  assert.equal(
    playersLine({ seated: true, others: 1, at: { x: -91, z: -71 } }),
    '2 players in this round · other at -91,-71 m');
});
