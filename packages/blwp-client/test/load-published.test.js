// THE LOAD REACHES THE NODE, AND IT REACHES IT ON THE TICK IT WAS DECLARED.
//
// Letter 40. How hard the war hunts a truck is decided by what is on its bed,
// and until this the page wrote that number straight into its own core through
// `BlwpSetHeat` - a host write in no batch, no mark and no transcript. The
// page's core carried 57229 and every replay of the same transcript carried 0,
// so a committee, and every GHOST a committee draws, walked a run the war was
// hunting less hard than the one the player was driving.
//
// The client's half is here: `submitLoad` holds the declaration against the
// tick the run has reached and publishes it with the batch that covers that
// tick. A real node, so what is measured is what the node ended up storing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
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

const FEE_SATS = 17314, BTC_HUND = 42;

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

async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([45875, 6000, 0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* a refusal is a measurement here */ } }
    await wait(2);
    if (!client.hold.length || client.ended) break;
  }
}

test('a load declared at roll-out is in the node\'s transcript at tick zero', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    // Roll-out: the round starts, the load is declared, then the driving.
    assert.equal(client.submitLoad(FEE_SATS, BTC_HUND), true);
    await drive(client, 300);

    const t = node.round.transcript(rid, eid);
    assert.equal(t.ticks.length, 300, `the node kept ${t.ticks.length} ticks`);
    assert.deepEqual(t.loads, [[0, FEE_SATS, BTC_HUND]],
      'the node stored no load, so every replay of this run is hunted at zero');
    assert.equal(client.loads.length, 0, 'the client is still holding a published load');
    console.log(`  ${t.ticks.length} ticks and the load [${t.loads[0]}] stored at tick ${t.loads[0][0]}`);
  } finally { await node.close(); }
});

test('a load declared mid-run rides the batch that covers its own tick', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await drive(client, 300);
    const at = client.offered;
    assert.equal(client.submitLoad(9000, 0), true);
    await drive(client, 300);

    const t = node.round.transcript(rid, eid);
    assert.equal(t.loads.length, 1);
    assert.equal(t.loads[0][0], at, `the load is at tick ${t.loads[0][0]} and was declared at ${at}`);
    assert.equal(t.loads[0][1], 9000);
    console.log(`  declared at tick ${at}, stored at tick ${t.loads[0][0]}`);

    // AND IT IS NOT AHEAD OF ITS OWN TICKS. A batch names the ticks it
    // carries; a load the node has no tick for yet would be a declaration
    // about a run that has not reached it.
    assert.ok(t.loads[0][0] < t.ticks.length, 'the load names a tick the transcript does not cover');
  } finally { await node.close(); }
});

test('a load held while the batch is still held goes out with those ticks', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    // Ticks recorded but nothing drained, then the load, then the drain: the
    // load's tick is inside the batch that is about to go out.
    for (let i = 0; i < 50; i++) client.record([45875, 6000, 0, 0, 0]);
    assert.equal(client.submitLoad(FEE_SATS, BTC_HUND), true);
    assert.equal(client.loads.length, 1);
    for (let i = 0; i < 50; i++) client.record([45875, 6000, 0, 0, 0]);

    for (let i = 0; i < 20 && client.hold.length; i++) {
      const p = client.drain();
      if (p) await p;
      await wait(2);
    }
    const t = node.round.transcript(rid, eid);
    assert.deepEqual(t.loads, [[50, FEE_SATS, BTC_HUND]]);
    assert.equal(client.loads.length, 0);
    console.log(`  declared at tick 50 with 100 ticks held, published inside the batch that carries it`);
  } finally { await node.close(); }
});

test('an ended run declares nothing more', async () => {
  const { node, client } = await rig();
  try {
    client.endRun('the test says so');
    assert.equal(client.submitLoad(FEE_SATS, BTC_HUND), false);
    assert.equal(client.loads.length, 0);
  } finally { await node.close(); }
});
