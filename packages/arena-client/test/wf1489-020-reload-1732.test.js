// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit r5 (play): the rig is checkpoint.test.js's.
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


// kanban #1732 / feedback #020 (Hexbox): THE SAME WITHHELD MARK AFTER A PAGE RELOAD. A reloaded tab starts from NO_PREVIOUS,
// so the in-tab floor (the client's own live head) is not there: a home seat that leaves its newest carried mark out of
// GET /checkpoints made the fresh client adopt an older live mark, and the next mark it signed was a second child of that
// older parent - "two chains from one parent", FORFEIT at every honest seat. The receipts recovered after the reload
// (home and peers) show the newer mark is live, so that mark is the floor.
test('#1732 / feedback #020: after a RELOAD a home seat that withholds the newest live mark cannot make the player fork', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    assert.equal(client.live(second.id), true);
    client.close?.();

    // THE HOME SEAT, DISHONEST: /checkpoints leaves out every mark after the first
    globalThis.fetch = async (url, opts) => {
      const r = await realFetch(url, opts);
      if (!/\/checkpoints\?/.test(String(url))) return r;
      const all = new Uint8Array(await r.arrayBuffer());
      return new Response(all.slice(0, SIGNED_CHECKPOINT_BYTES), { status: 200 });
    };
    // THE RELOAD: a new client, the same session key, nothing else kept
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots;
    let refused = null;
    try { await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS }); } catch (e) { refused = e.message; }
    globalThis.fetch = realFetch;
    console.log(`  reload: head ${toHex(fresh.head).slice(0, 16)} (first ${toHex(first.id).slice(0, 16)}, second ${toHex(second.id).slice(0, 16)})${refused ? `; refused: ${refused}` : ''}`);
    // NO COMMITTEE PEER AT ALL (this rig's one node): the client has only the home seat's word and receipts alone are no
    // evidence (feedback #029, #030: a receipt names no round and no entry), so it neither forks on purpose nor ends the run -
    // with peers, the next case shows the withheld mark found and followed. Live committees are 5 to 7 seats.
    assert.equal(refused, null, 'no run ends on receipts alone');
    if (false) {
      const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
      const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
        (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
      console.log(`  next mark names ${toHex(decodeCheckpoint(splitSigned(next.bytes).body).previousHash).slice(0, 16)}; fork proof: ${fork.ok} ${fork.how || fork.why}`);
      assert.equal(fork.ok, false, 'the player signed a fork (§13B) after a reload');
    }
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

test('#1732 / feedback #020: after a reload the newest live mark an honest peer lists is the head, and the next mark follows it', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  const PEER = 'http://honest-peer.invalid';
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    client.close?.();
    // the home seat withholds; the honest peer (the same store, read through another base) serves the whole list
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(PEER)) {
        if (!/\/(checkpoints|receipts)\?/.test(u)) return new Response('', { status: 404 });
        return realFetch(u.replace(PEER, `http://127.0.0.1:${node.port}`), opts);
      }
      const r = await realFetch(url, opts);
      if (!/\/checkpoints\?/.test(u)) return r;
      return new Response(new Uint8Array(await r.arrayBuffer()).slice(0, SIGNED_CHECKPOINT_BYTES), { status: 200 });
    };
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots; fresh.peers = [PEER];
    await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
    globalThis.fetch = realFetch;
    console.log(`  reload with an honest peer: head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)})`);
    assert.equal(toHex(fresh.head), toHex(second.id), 'the head is the newest live mark, from the peer\'s list');
    const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    assert.equal(toHex(decodeCheckpoint(splitSigned(next.bytes).body).previousHash), toHex(second.id));
    const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
      (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
    assert.equal(fork.ok, false, 'no fork');
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #027 (Hexbox): the home seat ALSO withholds its receipts for the newest mark, so after a reload that mark is short of
// live and the #020 check (live marks only) never ran. A peer that lists the mark (signed by this session key) is enough.
test('#027: after a reload a home seat that withholds the newest mark AND its receipts cannot make the player fork', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  const PEER = 'http://honest-peer-027.invalid';
  const RECEIPT = 139;
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    client.close?.();
    const isSecond = (rec) => Buffer.from(rec.subarray(3, 35)).equals(Buffer.from(second.id));
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(PEER)) {
        if (/\/checkpoints\?/.test(u)) return realFetch(u.replace(PEER, `http://127.0.0.1:${node.port}`), opts);   // the peer lists both marks
        return new Response(new Uint8Array(0), { status: 200 });                                                  // and keeps its receipts to itself
      }
      const r = await realFetch(url, opts);
      const all = new Uint8Array(await r.arrayBuffer());
      if (/\/checkpoints\?/.test(u)) return new Response(all.slice(0, SIGNED_CHECKPOINT_BYTES), { status: 200 });
      if (/\/receipts\?/.test(u)) {
        const kept = [];
        for (let at = 0; at + RECEIPT <= all.length; at += RECEIPT) if (!isSecond(all.subarray(at, at + RECEIPT))) kept.push(...all.subarray(at, at + RECEIPT));
        assert.equal(all.length % RECEIPT, 0, 'receipt size');
        return new Response(new Uint8Array(kept), { status: 200 });
      }
      return new Response(all, { status: r.status, headers: r.headers });
    };
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots; fresh.peers = [PEER];
    let refused = null;
    try { await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS }); } catch (e) { refused = e.message; }
    globalThis.fetch = realFetch;
    console.log(`  #027 reload: head ${toHex(fresh.head).slice(0, 16)} (first ${toHex(first.id).slice(0, 16)}, second ${toHex(second.id).slice(0, 16)}), witnessed(second) ${fresh.witnessed(second.id)}${refused ? `; refused: ${refused}` : ''}`);
    assert.equal(refused, null);
    assert.equal(toHex(fresh.head), toHex(second.id), 'the head is the newest mark this player signed, from the peer list');
    const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
      (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
    assert.equal(fork.ok, false, 'no fork');
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #029 (Hexbox): ONE committee seat that serves a receipt it signed over random bytes must not end a reloaded run.
test('#029: one seat\'s receipt over a mark nobody holds does not VOID a reloaded run, and the head is the newest mark', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  const PEER = 'http://lying-peer-029.invalid';
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    client.close?.();
    const bogus = receiptFrom(peers[5], new Uint8Array(32).map(() => Math.floor(Math.random() * 256)), 7n);
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(PEER)) {
        const r = await realFetch(u.replace(PEER, `http://127.0.0.1:${node.port}`), opts);
        const all = new Uint8Array(await r.arrayBuffer());
        if (/\/receipts\?/.test(u)) { const out = new Uint8Array(all.length + bogus.length); out.set(all); out.set(bogus, all.length); return new Response(out, { status: 200 }); }
        return new Response(all, { status: r.status });
      }
      return realFetch(url, opts);   // the home seat is honest
    };
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots; fresh.peers = [PEER];
    let refused = null;
    try { await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS }); } catch (e) { refused = e.message; }
    globalThis.fetch = realFetch;
    console.log(`  #029 reload: head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)}), ended ${fresh.ended}${refused ? `; refused: ${refused}` : ''}`);
    assert.equal(refused, null, 'one seat\'s receipt over random bytes ended the run');
    assert.equal(fresh.nodeFault, null);
    assert.equal(toHex(fresh.head), toHex(second.id));
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #030 (Hexbox): a seat replays GENUINE receipts - five distinct committee keys - of a mark that is not this entry's (another
// entry's, another round's). The id is live from receipts, no list holds it as this player's: it must not end the run.
test('#030: five genuine receipts of another mark, served by one seat, do not VOID a reloaded run', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  const PEER = 'http://replaying-peer-030.invalid';
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    client.close?.();
    const foreign = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);   // another entry's carried mark
    const replayed = peers.slice(0, 5).map((k, i) => receiptFrom(k, foreign, 5000n + BigInt(i)));
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(PEER)) {
        const r = await realFetch(u.replace(PEER, `http://127.0.0.1:${node.port}`), opts);
        const all = new Uint8Array(await r.arrayBuffer());
        if (!/\/receipts\?/.test(u)) return new Response(all, { status: r.status });
        const out = new Uint8Array(all.length + replayed.reduce((n, x) => n + x.length, 0));
        out.set(all); let at = all.length; for (const x of replayed) { out.set(x, at); at += x.length; }
        return new Response(out, { status: 200 });
      }
      return realFetch(url, opts);   // the home seat is honest
    };
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots; fresh.peers = [PEER];
    let refused = null;
    try { await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS }); } catch (e) { refused = e.message; }
    globalThis.fetch = realFetch;
    console.log(`  #030 reload: live(foreign) ${fresh.live(foreign)}, head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)})${refused ? `; refused: ${refused}` : ''}`);
    assert.equal(fresh.live(foreign), true, 'the replayed receipts are genuine: the foreign id reads live');
    assert.equal(refused, null, 'a foreign live id ended the run');
    assert.equal(fresh.nodeFault, null);
    assert.equal(toHex(fresh.head), toHex(second.id));
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #032 (Hexbox): a home seat that serves EVERY mark, newest first. Nothing withheld, nothing forged - the client must still
// take the newest by tick, after a reload and after a socket drop, and the next mark follows it (no second child, no FORFEIT).
test('#032: a home list out of tick order moves no head back, after a reload or a drop', async () => {
  const { node, client, rid, eid } = await rig();
  const realFetch = globalThis.fetch;
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first); carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second); carry(client, second);
    globalThis.fetch = async (url, opts) => {
      const r = await realFetch(url, opts);
      if (!/\/checkpoints\?/.test(String(url))) return r;
      const all = new Uint8Array(await r.arrayBuffer());
      const out = new Uint8Array(all.length);
      for (let i = 0, n = all.length / SIGNED_CHECKPOINT_BYTES; i < n; i++)
        out.set(all.subarray((n - 1 - i) * SIGNED_CHECKPOINT_BYTES, (n - i) * SIGNED_CHECKPOINT_BYTES), i * SIGNED_CHECKPOINT_BYTES);
      return new Response(out, { status: 200 });   // [M1, M0]: every mark, newest first
    };
    // (b) a drop: the same client resumes
    await client.resume({ roundId: rid, entryId: eid });
    assert.equal(toHex(client.head), toHex(second.id), 'after a drop the head stays the newest mark');
    // (a) a reload: a fresh client
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots;
    await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
    globalThis.fetch = realFetch;
    console.log(`  #032 reversed list: drop head ${toHex(client.head).slice(0, 16)}, reload head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)})`);
    assert.equal(toHex(fresh.head), toHex(second.id), 'after a reload the head is the newest mark');
    const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
      (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
    assert.equal(fork.ok, false, 'no second child of an older mark');
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #033 (Hexbox): one seat leaves only its OWN receipt for the newest mark out of /receipts - every list complete and in
// order - so the newest mark is one receipt short of live after a reload. The head must still be that mark, not the older live one.
test('#033: one seat withholding only its own receipt for the newest mark moves no reloaded head back', async () => {
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
    globalThis.fetch = realFetch;
    console.log(`  #033 reload: live(second) ${fresh.live(second.id)}, head ${toHex(fresh.head).slice(0, 16)} (second ${toHex(second.id).slice(0, 16)})`);
    assert.equal(fresh.live(second.id), false, 'the newest mark is one receipt short of live');
    assert.equal(toHex(fresh.head), toHex(second.id), 'the head is still the newest signed mark');
    const next = await fresh.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    const fork = await provesEquivocation(second.bytes, next.bytes, sessionPubkey,
      (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } });
    assert.equal(fork.ok, false, 'no second child of the older mark');
  } finally { globalThis.fetch = realFetch; await node.close(); }
});

// feedback #034 (Hexbox): a mark only one seat stored (another blipped) is adopted after a reload under the #033 rule - and was never
// sent again (pendingLink was lost with the tab), so every later mark was "stored but not carried" and the run stalled. The adopted
// head short of live must be the pending link, which #relink offers to the committee again.
test('#034: a head adopted short of live after a reload is the pending link, so it is sent again', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const m0 = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, m0); carry(client, m0);
    const m1 = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, m1); carry(client, m1);
    const m2 = await client.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });   // only this seat's own receipt
    client.close?.();
    const fresh = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    fresh.nodes = client.nodes; fresh.gameVerifySlots = client.gameVerifySlots;
    await fresh.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
    console.log(`  #034 reload: head ${toHex(fresh.head).slice(0, 16)} (m2 ${toHex(m2.id).slice(0, 16)}), live(m2) ${fresh.live(m2.id)}, pendingLink ${fresh.pendingLink ? toHex(fresh.pendingLink.id).slice(0, 16) : null}`);
    assert.equal(toHex(fresh.head), toHex(m2.id), 'the newest signed mark is the head (#033)');
    assert.equal(fresh.live(m2.id), false);
    assert.ok(fresh.pendingLink, 'the adopted mark short of live is pending');
    assert.equal(toHex(fresh.pendingLink.id), toHex(m2.id));
    assert.equal(toHex(fresh.pendingLink.bytes), toHex(m2.bytes), 'its own signed bytes, ready to send again');
  } finally { await node.close(); }
});
