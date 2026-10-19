// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S SOCKET DROPPING BEFORE THE ROUND STARTS (rig from own-socket-drop.test.js).
//
// Measured 2026-09-10 on one real daemon, the page's reconnect wired as the
// bridge wires it: the socket closed twice with a batch in flight, and the
// client counted each close as the node refusing ("error the socket closed"),
// resynced on the first and ended an honest run on the second: "VOID: the
// node refuses this run's inputs at tick 60". The node refused nothing.
//
// And when the node HAD taken the batch and only the answer was lost, the
// resume read the node's next tick but kept the words in the hold, so they
// went out again at the node's next tick: tick 90 held the input recorded for
// 60, and the node held 150 ticks for 120 recorded.
//
// Every tick here carries its own index in its second word, so a tick that
// lands anywhere but its own place is seen.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused as a contract disagreeing
// with the network it names.
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { serve } from '../../arena-node/src/server.js';
import { openStore } from '../../arena-node/src/store.js';
import { Client } from '../src/client.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = ed25519.utils.randomSecretKey();
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

/** One real daemon and a joined client, reconnecting the way the bridge does. */
async function rig() {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  const client = new Client({
    base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify,
  });
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
    blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  assumeStakeSeen(node.round, mine);
  // AS THE PAGE DOES IT (blwp.jslib net.opened): the socket opens beside the round and the entry, the reconnect is wired
  // with the page's own `where`, and setRound waits for the round's start
  const where = { roundId: rid, entryId: eid };
  client.onDrop = () => { client.reconnect(where).then((r) => { if (r) reconnects.push(r.nextTick); }); };
  const reconnects = [];
  await client.connectFirst({ untilMs: Date.now() + 10000 });
  const start = () => client.setRound({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
  let recorded = 0;
  const rec = (n) => { for (let i = 0; i < n; i++) client.record([45875, recorded++, 0, 0, 0]); };
  const settle = async () => {
    for (let i = 0; i < 50 && client.state !== 'ready' && !client.ended; i++) await wait(100);
    if (client.recovering) await client.recovering.catch(() => {});
  };
  const publishAll = async () => {
    for (let i = 0; i < 50 && (client.hold.length || client.publishing) && !client.ended; i++) {
      await (client.drain() || client.publishing);
      await client.awaitPublishes();
    }
  };
  const onNode = async () => {
    const r = await fetch(`http://127.0.0.1:${node.port}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`);
    return decodeTranscript(new Uint8Array(await r.arrayBuffer())).batches.flatMap((b) => b.ticks.map((w) => w[1]));
  };
  return { node, client, rid, eid, rec, settle, publishAll, onNode, recorded: () => recorded, start, reconnects };
}


// THE SOCKET DROPS BEFORE THE ROUND STARTS (measured 2026-10-03 21:38:50Z on testnet4, paid round 8bed315a, page 0.0.2505):
// the page's socket dropped ~9 s before the start, the client reconnected ("resumed at tick 0 after 1 try(s), 0 batches"),
// and from the start on not one tick left the page - "1469 tick(s) could not be sent"; all 7 seats held the entry and the
// lock, 0 ticks. Here: the socket opened beside the join, dropped and reconnected before setRound, then the run is played.
test('a socket that drops and reconnects before the round starts still publishes every tick of the run', async () => {
  const r = await rig();
  const { node, client, rec, settle, publishAll, onNode, recorded, start, reconnects } = r;
  try {
    client.sock.close();                                  // the tunnel blinks, before the start
    for (let i = 0; i < 100 && !reconnects.length; i++) await wait(20);
    await settle();
    const before = { reconnects: [...reconnects], state: client.state, reconnecting: !!client.reconnecting, recovering: !!client.recovering,
      open: !!(client.sock && client.sock.readyState === 1), nextTick: client.nextTick };
    start();                                              // the round's start: the page enters the world
    rec(120);
    const first = client.drain();
    const gate = { publishing: !!client.publishing, held: client.hold.length, where: !!client.where, open: !!(client.sock && client.sock.readyState === 1),
      reconnecting: !!client.reconnecting, recovering: !!client.recovering, state: client.state, drained: first === null ? 'null' : typeof first };
    await publishAll();
    const held = await onNode();
    console.log('  FACTS:', JSON.stringify({ before, gate, recorded: recorded(), nodeHolds: held.length, ended: client.ended && client.endingReason }));
    assert.deepEqual(before.reconnects, [0], 'the drop before the start was not reconnected');
    assert.equal(client.ended, false, `the run ended: ${client.ending} ${client.endingReason}`);
    assert.equal(held.length, recorded(), `the node holds ${held.length} ticks for ${recorded()} recorded`);
    assert.equal(held.findIndex((v, i) => v !== i), -1);
  } finally { client.ended = true; client.close(); await node.close(); }
});

// AND THE NEW SOCKET DROPS TOO, WHILE THE RECONNECT IS STILL RESUMING - what the stuck page held (read from the live tab,
// round 8bed315a after its end): drops 2, tries 1, batchesSent 0, no publish in flight, no socket, state 'ready'. The second
// close found the first reconnect in flight, so its onDrop got that same promise back and started nothing; the resume
// answered from the CLOSED words, and the reconnect called the run ready with no socket under it. Nothing ever closed again,
// so nothing ever reconnected, and every drain stopped at "no socket".
test('a second drop while the reconnect is resuming is reconnected too: the run is not left ready with no socket', async () => {
  const r = await rig();
  const { node, client, rec, settle, publishAll, onNode, recorded, start, reconnects } = r;
  try {
    const resume = client.resume.bind(client);
    let blinked = 0;
    client.resume = async (w) => {
      if (!blinked++) { client.sock.close(); await wait(50); }   // the tunnel blinks again, mid-resume
      return resume(w);
    };
    client.sock.close();                                  // the first blink, before the start
    for (let i = 0; i < 150 && !(reconnects.length && client.sock && client.sock.readyState === 1); i++) await wait(20);
    await settle();
    const before = { reconnects: [...reconnects], drops: client.drops, tries: client.tries, state: client.state,
      open: !!(client.sock && client.sock.readyState === 1) };
    start();
    rec(120);
    await publishAll();
    const held = await onNode();
    console.log('  FACTS:', JSON.stringify({ before, batchesSent: client.batchesSent, recorded: recorded(), nodeHolds: held.length,
      ended: client.ended && client.endingReason }));
    assert.equal(before.drops, 2);
    assert.ok(before.open, `ready with no socket under it: ${JSON.stringify(before)}`);
    assert.equal(client.ended, false, `the run ended: ${client.ending} ${client.endingReason}`);
    assert.equal(held.length, recorded(), `the node holds ${held.length} ticks for ${recorded()} recorded`);
    assert.equal(held.findIndex((v, i) => v !== i), -1);
  } finally { client.ended = true; client.close(); await node.close(); }
});
