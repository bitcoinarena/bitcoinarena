// THE RUN STOPS WHEN THE CORE SAYS IT IS OVER (the owner 2026-09-15 16:14).
//
// Measured before, replaying every run a signer node held: each truck that drove into the miner's
// mouth was DELIVERED in the core - and its page recorded 620 to 5319 more ticks (10-89 s) while the
// truck sat at the tunnel's back wall. `finish` is handed the core's word by the page; this measures
// what it does with it on one real daemon: every held tick reaches the node, nothing after, the run
// ends FINISHED (not an outcome - that is the replay's), and the socket is closed.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
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
import { assumeStakeSeen } from '../../blwp-node/test/seating.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = ed25519.utils.randomSecretKey();
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

async function rig() {
  const node = await serve(openStore(), { port: 0, funded: () => true });
  const client = new Client({
    base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify,
  });
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
  };
  try {
  const rid = await client.openRound(c);
  const mine = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(mine);
  assumeStakeSeen(node.round, mine);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: 9000 });
  let recorded = 0;
  const rec = (n) => { let took = 0; for (let i = 0; i < n; i++) if (client.record([45875, recorded, 0, 0, 0])) { recorded++; took++; } return took; };
  const onNode = async () => {
    const r = await fetch(`http://127.0.0.1:${node.port}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`);
    return decodeTranscript(new Uint8Array(await r.arrayBuffer())).batches.flatMap((b) => b.ticks.map((w) => w[1]));
  };
  return { node, client, rec, onNode, recorded: () => recorded };
  } catch (e) { client.ended = true; client.close(); await node.close(); throw e; }
}

test('when the core says the run is over, every held tick reaches the node, nothing is recorded or sent after, and the run ends FINISHED', async () => {
  const { node, client, rec, onNode, recorded } = await rig();
  try {
    rec(60);
    await client.drain();
    await client.awaitPublishes();
    rec(47);                                     // held, not yet sent, when the core says it
    const heldAtFinish = client.hold.length;
    assert.equal(client.over, false, 'a live run read as over');
    assert.equal(client.endingLine(), '');
    const done = client.finish({ tick: recorded(), why: 'the core said DELIVERED at tick 107' });
    // THE GAME IS TOLD AT THE WORD, not when the wire is done: measured live, waiting for the last
    // publish put the lobby 2241 ms after DELIVERED.
    const overAtWord = client.over, endedAtWord = client.ended, lineAtWord = client.endingLine();
    const tookAfter = rec(30);                   // the game keeps stepping; none of it is the run
    const r = await done;
    assert.equal(overAtWord, true, 'the run was not over for the game at the core\'s word');
    assert.equal(endedAtWord, false, 'the run ended before the last of it went out');
    assert.match(lineAtWord, /^FINISHING the core said DELIVERED at tick 107$/);
    assert.match(client.endingLine(), /^FINISHED the core said DELIVERED at tick 107$/);
    await wait(300);
    const held = await onNode();
    const line = client.status(client.offered);
    console.log(`  finish: held at finish ${heldAtFinish}, recorded ${recorded()}, taken after finish ${tookAfter}, `
      + `node holds ${held.length}, unsent ${r && r.unsent}; ${line}`);
    assert.ok(heldAtFinish > 0, 'nothing was held when the core ended the run, so the drain was not measured');
    assert.equal(tookAfter, 0, 'ticks after the core ended the run were recorded');
    assert.equal(held.length, 107, 'the node does not hold exactly the ticks up to the end');
    assert.equal(held.findIndex((v, i) => v !== i), -1, 'a tick landed out of its place');
    assert.equal(r.unsent, 0);
    assert.equal(client.ended, true);
    assert.equal(client.ending, 'FINISHED', `ended ${client.ending}: ${client.endingReason}`);
    assert.equal(client.hold.length, 0);
    assert.equal(client.sock, null, 'the socket was left open');
    assert.equal(/VOID|refused/.test(line), false, `the line says VOID or refused: ${line}`);
    // AND STILL NOTHING, a moment later.
    assert.equal(client.record([45875, 999, 0, 0, 0]), false);
    assert.equal(client.drain(), null);
    await wait(300);
    assert.equal((await onNode()).length, 107, 'the node took ticks after the run ended');
    // A second word from the core changes nothing.
    assert.equal(await client.finish({ tick: 500, why: 'again' }), null);
  } finally { client.ended = true; client.close(); await node.close(); }
});
