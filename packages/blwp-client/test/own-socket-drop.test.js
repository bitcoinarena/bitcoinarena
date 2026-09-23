// THE PLAYER'S OWN CONNECTION DROPPING IS A DISCONNECT, NOT A REFUSAL.
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
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused as a contract disagreeing
// with the network it names.
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { serve } from '../../blwp-node/src/server.js';
import { openStore } from '../../blwp-node/src/store.js';
import { Client } from '../src/client.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { decodeTranscript } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';
import { assumeStakeSeen } from '../../blwp-node/test/assignment.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = ed25519.utils.randomSecretKey();
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

/** One real daemon and a joined client, reconnecting the way the bridge does. */
async function rig() {
  const node = await serve(openStore(), { port: 0, funded: () => true });
  const client = new Client({
    base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify,
  });
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
  };
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  assumeStakeSeen(node.round, mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
  client.onDrop = () => { client.reconnect(client.where); };
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
  return { node, client, rid, eid, rec, settle, publishAll, onNode, recorded: () => recorded };
}

/** The frame never reaches the node; the player's socket closes 5 ms later. */
const frameLost = (client) => {
  const s = client.sock;
  const send = s.send.bind(s);
  s.send = () => { s.send = send; setTimeout(() => s.close(), 5); };
};

/** The node takes the frame (through another socket); the player's socket closes before any answer. */
const answerLost = (client, node) => {
  const s = client.sock;
  const send = s.send.bind(s);
  s.send = (m) => {
    s.send = send;
    const side = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
    side.binaryType = 'arraybuffer';
    side.onopen = () => side.send(m);
    side.onmessage = () => { side.close(); s.close(); };
  };
};

async function twoDrops(dropper) {
  const r = await rig();
  const { client, rec, settle, publishAll } = r;
  rec(60);
  await client.drain();
  await client.awaitPublishes();
  const answers = [];
  for (let n = 1; n <= 2; n++) {
    rec(30);
    dropper(client, r.node);
    const a = await client.drain();
    answers.push(a && a.answer);
    await settle();
  }
  rec(30);
  await publishAll();
  return { ...r, answers };
}

test('two drops of the player\'s own socket with the batch lost in flight leave the run alive, and every tick is published in its place', async () => {
  const { node, client, answers, onNode, recorded } = await twoDrops(frameLost);
  try {
    const held = await onNode();
    const wrong = held.findIndex((v, i) => v !== i);
    console.log(`  frame lost x2: answers ${JSON.stringify(answers)}; ${client.ended ? 'ENDED ' + client.ending : 'alive'}; `
      + `recorded ${recorded()}, node holds ${held.length}, first misplaced ${wrong}; ${client.status(client.offered)}`);
    assert.equal(client.ended, false, `the run ended: ${client.ending} ${client.endingReason}`);
    assert.ok(answers.every((a) => /^closed: /.test(a)), `a drop did not read as a closed link: ${answers}`);
    assert.equal(client.refusals, 0, 'a dropped socket was counted as the node refusing');
    assert.equal(client.batchesInterrupted, 2);
    assert.equal(client.drops, 2);
    assert.equal(held.length, recorded(), 'not every recorded tick reached the node');
    assert.equal(wrong, -1, `tick ${wrong} holds the input recorded for ${held[wrong]}`);
    assert.equal(client.nextTick + client.held, client.offered);
    const line = client.status(client.offered);
    assert.equal(/refused|VOID/.test(line), false, `the line says refused or VOID: ${line}`);
    assert.match(line, / interrupted 2\b/);
  } finally { client.ended = true; client.close(); await node.close(); }
});

test('two drops after the node took the batch but before its answer: nothing is sent twice and nothing is shifted', async () => {
  const { node, client, answers, onNode, recorded } = await twoDrops(answerLost);
  try {
    const held = await onNode();
    const wrong = held.findIndex((v, i) => v !== i);
    console.log(`  answer lost x2: answers ${JSON.stringify(answers)}; ${client.ended ? 'ENDED ' + client.ending : 'alive'}; `
      + `recorded ${recorded()}, node holds ${held.length}, first misplaced ${wrong}, landed unheard `
      + `${client.batchesLandedUnheard}; ${client.status(client.offered)}`);
    assert.equal(client.ended, false, `the run ended: ${client.ending} ${client.endingReason}`);
    assert.equal(client.refusals, 0);
    assert.equal(client.batchesInterrupted, 2);
    assert.equal(client.batchesLandedUnheard, 2, 'the resume did not see that the node had taken each batch');
    assert.equal(held.length, recorded(), `the node holds ${held.length} ticks for ${recorded()} recorded`);
    assert.equal(wrong, -1, `tick ${wrong} holds the input recorded for ${held[wrong]}`);
    assert.equal(client.nextTick + client.held, client.offered);
    // and the list the peers are fed from is the node's own, batch for batch
    assert.equal(client.published.at(-1).through, client.nextTick);
  } finally { client.ended = true; client.close(); await node.close(); }
});

// A DRAIN WHILE THE RECONNECT IS STILL RESUMING (measured live on the Daily, 2026-09-15 12:21Z, a
// free round through a quick tunnel): the socket dropped with a batch the node had stored and whose
// answer was lost; the reconnect opened a new socket - `state` ready - and only then read where the
// node is. The page drains every frame, so in between a batch went out from the OLD tick and head:
// "the batch does not follow the chain head", the one resync spent, and the run ended at tick 180
// with the node holding ticks the client never counted (signer node A 12 batches, the client 10).
// The reconnect's resume is held for 200 ms here, so the window is not a matter of luck.
test('a drain while the reconnect is still resuming sends nothing from the old numbers: no refusal, and every tick lands in its place', async () => {
  const { node, client, rec, settle, publishAll, onNode, recorded } = await rig();
  try {
    rec(60);
    await client.drain();
    await client.awaitPublishes();
    const resume = client.resume.bind(client);
    client.resume = async (w) => { await wait(200); return resume(w); };
    rec(30);
    answerLost(client, node);
    await client.drain();                               // the node takes 60..89; the answer is lost
    for (let i = 0; i < 100 && !(client.reconnecting && client.sock && client.sock.readyState === 1); i++) await wait(5);
    const midway = { reconnecting: !!client.reconnecting, open: !!(client.sock && client.sock.readyState === 1), nextTick: client.nextTick };
    rec(10);
    const early = client.drain();                       // the page's next frame, mid-reconnect
    if (early && early.then) await early.catch(() => {});
    await settle();
    rec(30);
    await publishAll();
    const held = await onNode();
    const wrong = held.findIndex((v, i) => v !== i);
    console.log(`  drain mid-reconnect: ${JSON.stringify(midway)}; refusals ${client.refusals} (${client.refusedWhy}); `
      + `${client.ended ? 'ENDED ' + client.endingReason : 'alive'}; recorded ${recorded()}, node holds ${held.length}, first misplaced ${wrong}`);
    assert.ok(midway.reconnecting && midway.open, 'the test did not reach the window between the new socket and the resume');
    assert.equal(client.refusals, 0, `a batch built from the pre-resume numbers was refused: ${client.refusedWhy}`);
    assert.equal(client.ended, false, `the run ended: ${client.ending} ${client.endingReason}`);
    assert.equal(held.length, recorded(), `the node holds ${held.length} ticks for ${recorded()} recorded`);
    assert.equal(wrong, -1, `tick ${wrong} holds the input recorded for ${held[wrong]}`);
  } finally { client.ended = true; client.close(); await node.close(); }
});

test('a node that actually says no is still a refusal: counted, resynced, and not an interruption', async () => {
  const { node, client, rec, publishAll, onNode, recorded } = await rig();
  try {
    rec(60);
    await client.drain();
    await client.awaitPublishes();
    // A BATCH NAMING A HEAD THE NODE NEVER HAD is refused by the node itself.
    client.batchHead = b32(9);
    rec(30);
    const r = await client.drain();
    console.log(`  a real no: "${r.answer}"; refusals ${client.refusals}, interrupted ${client.batchesInterrupted}`);
    assert.match(r.answer, /^error .*chain head/, `the node did not refuse as expected: ${r.answer}`);
    assert.equal(client.refusals, 1, 'a node saying no was not counted as a refusal');
    assert.equal(client.batchesInterrupted, 0, 'a node saying no was counted as a dropped link');
    assert.match(client.refusedWhy, /chain head/);
    if (client.recovering) await client.recovering;
    rec(30);
    await publishAll();
    const held = await onNode();
    assert.equal(client.ended, false, 'one refusal resyncs; it does not end the run');
    assert.equal(held.length, recorded());
    assert.equal(held.findIndex((v, i) => v !== i), -1);
  } finally { client.ended = true; client.close(); await node.close(); }
});
