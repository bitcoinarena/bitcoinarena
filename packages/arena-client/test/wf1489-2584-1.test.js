// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2584 (attacker audit of the reload/resume head): the rig is wf1489-020-reload-1732.test.js's.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { assumeAssigned, assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { serve } from '../../arena-node/src/server.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import {
  decodeCheckpoint, checkpointId, splitSigned, NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from '../../arena-protocol/src/checkpoint.js';
import { GENESIS, encodeTranscript } from '../../arena-protocol/src/transcript.js';
import { batchId } from '../../arena-protocol/src/batch.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { Client, markState, RECEIPTS_FOR_LIVE, catchUpCore } from '../src/client.js';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, encodeCheckpointReceipt,
  joinSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../arena-protocol/src/receipt.js';
import { createServer } from 'node:http';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { provesEquivocation } from '../../arena-protocol/src/checkpoint.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
// FUNDED, because these are rounds somebody paid for. A node started without
// being told who pays refuses everything now - disk is spent only on stakes
// that exist - so a test that means to play a round has to say so.
const FUNDED = { funded: () => true };

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** A core that has actually been driven, so its hash is a state and not a seed. */
function driven(ticks) {
  const st = core.init(7);
  for (let t = 0; t < ticks; t++) core.step(st, 45875, 0, 0, 0);   // 0.7 throttle
  return st;
}

const marks = async (port, rid, eid) => {
  const r = await fetch(`http://127.0.0.1:${port}/checkpoints?round=${toHex(rid)}&entry=${toHex(eid)}`);
  return { count: Number(r.headers.get('x-checkpoints')), bytes: new Uint8Array(await r.arrayBuffer()) };
};

/**
 * THE OTHER SIX OF THE COMMITTEE, as keys rather than as daemons.
 *
 * Section 13C wants receipts from five committee nodes before a checkpoint
 * chain is canonical, and there is one real node here. The rest are real
 * Ed25519 keys that sign real `CheckpointReceipt`s, fed to the client through
 * the same door a gossiped receipt arrives by - so nothing is stubbed except
 * who is at the other end of the wire, and every signature the client accepts
 * it verified itself.
 */
const peers = Array.from({ length: 6 }, () => ed25519.utils.randomSecretKey());
const peerKeys = peers.map((k) => schnorr.getPublicKey(k));

/** One committee member's receipt for a mark, signed for real. */
function receiptFrom(secret, markId, receivedAtMs) {
  const r = {
    checkpointId: markId, nodePubkey: schnorr.getPublicKey(secret), receivedAtMs,
  };
  return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), secret));
}

/**
 * Carries a mark to the five 13C asks for: the node's own receipt plus four
 * more, each verified by the client the same three ways.
 */
function carry(client, mark, howMany = 4) {
  for (let i = 0; i < howMany; i++) {
    client.readReceipt(receiptFrom(peers[i], mark.id, 1000n + BigInt(i)), mark.id);
  }
  return client.witnessed(mark.id);
}

/**
 * The same four, but LEFT WITH THE NODE, over the gossip door a peer's receipt
 * really arrives by. A client that reconnects recovers what the node holds, so
 * a mark is only live after a drop if the committee's receipts survived the
 * drop too.
 */
async function gossipCarry(client, mark, howMany = 4) {
  for (let i = 0; i < howMany; i++) {
    // The encoding already carries its own type byte, so the receipt goes on
    // the wire exactly as it was signed - adding a frame made it 140 bytes and
    // the node said so.
    assert.equal(await client.send(receiptFrom(peers[i], mark.id, 1000n + BigInt(i))), 'held');
  }
}

/**
 * THE INPUTS FIRST, as a client sends them. A node refuses a checkpoint at a
 * tick whose inputs it does not hold, and every mark these tests send is at
 * 400 or less - so 600 ticks go out, through the client's own batch path so
 * its chain head and next tick agree with the node's.
 */
async function inputs(client, rid, eid, ticks = 600) {
  const r = await client.batch(Array.from({ length: ticks }, () => [45875, 0, 0, 0, 0]),
    { roundId: rid, entryId: eid });
  assert.equal(r.accepted, ticks, `the node did not take the inputs: ${r.answer}`);
}

async function rig() {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  // The committee is this node plus six more keys, because 13C counts five of
  // seven and one node cannot be five however many times it answers.
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = { ...contract(), nodes: [node.round.pubkey, ...peerKeys] };
  const rid = await client.openRound(c);
  assert.deepEqual(rid, roundId(c), 'the node named a different round than the contract hashes to');
  // WHO THE CENSUS ASSIGNED, stated: since letter 26 a node trusts the assigned
  // keys and refuses a round it was never assigned. This file is about marks and
  // receipts; the joining rule itself is measured in arena-node's
  // `signer-node-committee.test.js`, from real blocks.
  assumeAssigned(node.round, rid, c.nodes);
  const e = entryFor(rid);
  const eid = await client.join(e);
  assert.deepEqual(eid, entryId(e), 'the node named a different entry than the contract hashes to');
  // AND WHOSE STAKE IT SAW PAID: 23.1 step 5, measured in arena-node's
  // `stake-committed.test.js`. This file is about marks, not payment.
  assumeStakeSeen(node.round, e);
  await client.connect();
  return { node, client, rid, eid };
}


// kanban #2584 finding 1: THE #033 HEAD, LOST AGAIN ON THE NEXT SOCKET DROP. After a reload the head is the newest signed mark
// even when one seat keeps it one receipt short of live (#033). The same home seat then closes the socket: `reconnect` runs a
// same-tab `resume`, `reloading` is false, the head is not live, so the live walk took the older live mark again and the next
// mark the player signed was a second child of it - FORFEIT, by one seat, with no second reload.
test('#2584-1: a socket drop after a #033 reload does not move the head back to the older live mark', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  const RECEIPT = 139;
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    client.close?.();
    const mine = Buffer.from(node.round.pubkey);
    globalThis.fetch = async (url, opts) => {
      const r = await realFetch(url, opts);
      if (!/\/receipts\?/.test(String(url))) return r;
      const all = new Uint8Array(await r.arrayBuffer()), kept = [];
      for (let at = 0; at + RECEIPT <= all.length; at += RECEIPT) {
        const rec = all.subarray(at, at + RECEIPT);
        const own = Buffer.from(rec.subarray(43, 75)).equals(mine) && Buffer.from(rec.subarray(3, 35)).equals(Buffer.from(second.id));
        if (!own) kept.push(...rec);
      }
      return new Response(new Uint8Array(kept), { status: 200 });   // its own receipt for M1 left out, nothing else
    };
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots;
    await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
    assert.equal(toHex(fresh.head), toHex(second.id), 'the reload took the newest signed mark (#033)');
    // the home seat closes the socket: `reconnect` resumes in the same tab (no reload)
    await fresh.resume({ roundId: rid, entryId: eid });
    globalThis.fetch = realFetch;
    console.log(`  #2584-1 drop after reload: live(second) ${fresh.live(second.id)}, head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)}, first ${toHex(first.id).slice(0, 16)})`);
    assert.equal(fresh.live(second.id), false, 'the newest mark is still one receipt short of live');
    assert.equal(toHex(fresh.head), toHex(second.id), 'the same-tab resume keeps the newest signed mark');
    const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
      (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
    assert.equal(fork.ok, false, 'no second child of the older mark');
  } finally { globalThis.fetch = realFetch; await node.close(); }
});
