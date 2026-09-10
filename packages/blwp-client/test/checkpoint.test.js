// THE CLIENT SIGNS A STATE HASH AND A NODE STORES IT.
//
// Everything under this was already built and none of it had ever been driven
// from the player's side: the core can hash its own state, the protocol can
// encode and sign a checkpoint, and the node can take one, refuse a second at
// the same tick and hand them back. What did not exist was anything that
// produced one - `encodeCheckpoint` was called by tests and by nothing else,
// and no client had ever opened a round.
//
// So this drives the whole path: a real node process on a real port, a round
// opened over HTTP, an entry joined that carries the session key, a REAL core
// stepped for real ticks, and the hash it produces signed and sent on /play.
//
// THE HASH IS THE CORE'S, not a constant and not this file's idea of one. It
// comes off `dist/blwp-core.js` - the bundle the browser loads, the same
// artefact the game runs - so what is committed to here is what a player would
// be committing to. A test that hashed thirty-two fixed bytes would pass with
// the core unplugged, which is the one thing it must not do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { assumeSeated } from '../../blwp-node/test/seating.js';
import { encodeRoundContract, encodeEntryContract } from '../../protocol/src/contracts.js';
import { serve } from '../../blwp-node/src/server.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import {
  decodeCheckpoint, checkpointId, splitSigned, NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { GENESIS, encodeTranscript } from '../../protocol/src/transcript.js';
import { batchId } from '../../protocol/src/batch.js';
import { toHex } from '../../protocol/src/hash.js';
import { Client, markState, RECEIPTS_FOR_LIVE } from '../src/client.js';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, encodeCheckpointReceipt,
  joinSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { createServer } from 'node:http';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
// FUNDED, because these are rounds somebody paid for. A node started without
// being told who pays refuses everything now - disk is spent only on stakes
// that exist - so a test that means to play a round has to say so.
const FUNDED = { funded: () => true };

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
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
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  // The committee is this node plus six more keys, because 13C counts five of
  // seven and one node cannot be five however many times it answers.
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = { ...contract(), nodes: [node.round.pubkey, ...peerKeys] };
  const rid = await client.openRound(c);
  assert.deepEqual(rid, roundId(c), 'the node named a different round than the contract hashes to');
  // WHO THE CENSUS SEATED, stated: since letter 26 a node trusts the seated
  // keys and refuses a round it never seated. This file is about marks and
  // receipts; the seating rule itself is measured in blwp-node's
  // `seated-committee.test.js`, from real blocks.
  assumeSeated(node.round, rid, c.nodes);
  const e = entryFor(rid);
  const eid = await client.join(e);
  assert.deepEqual(eid, entryId(e), 'the node named a different entry than the contract hashes to');
  await client.connect();
  return { node, client, rid, eid };
}

test('the client sends a state hash and the node stores it at that tick', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const st = driven(120);
    const own = core.hash(st);
    assert.equal(own.length, 64, 'a state hash is 32 bytes of hex');
    assert.notEqual(own, core.hash(core.init(7)), 'a driven core must not hash like a fresh one');

    const sent = await client.checkpoint(st, { roundId: rid, entryId: eid, tick: 120 });
    assert.equal(sent.answer, 'receipted', `the node refused the mark: ${sent.answer}`);

    // THE RECEIPT, checked by the client and recomputed here independently.
    assert.ok(sent.receipt, 'no receipt came back');
    assert.deepEqual(sent.receipt.checkpointId, sent.id);
    assert.deepEqual(sent.receipt.nodePubkey, node.round.pubkey);
    assert.ok(sent.receipt.receivedAtMs > 0n, 'a receipt with no time is not evidence of one');

    // AND THE NODE IS HOLDING WHAT THE CLIENT COMPUTED, not merely something.
    const got = await marks(node.port, rid, eid);
    assert.equal(got.count, 1);
    assert.equal(got.bytes.length, SIGNED_CHECKPOINT_BYTES);

    const { body, signature } = splitSigned(got.bytes);
    const stored = decodeCheckpoint(body);
    assert.deepEqual(checkpointId(stored), sent.id, 'the stored id is not the one the client signed');
    assert.equal(stored.tick, 120);
    assert.deepEqual(stored.previousHash, NO_PREVIOUS, 'the first mark of a round chains to nothing');
    assert.deepEqual(stored.inputChainHash, GENESIS, 'the mark names no batch, so it names the genesis');
    assert.equal(toHex(stored.stateHash), own,
      'the hash on the wire is not the hash the core produced');
    assert.ok(ed25519.verify(signature, sent.id, sessionPubkey),
      'the stored signature does not verify under the session key in the entry contract');
  } finally { client.close(); await node.close(); }
});

test('a second, different hash at the same tick is refused as equivocation', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(first.answer, 'receipted');

    // The same tick, a state the core reached by a DIFFERENT drive - which is
    // what section 13B forfeits a player for publishing.
    const other = core.init(7);
    for (let t = 0; t < 60; t++) core.step(other, -45875, 0, 0, 0);   // reversing
    assert.notEqual(core.hash(other), core.hash(driven(60)), 'the two drives must differ');

    const second = await markState(core, other,
      { roundId: rid, entryId: eid, tick: 60, previousHash: NO_PREVIOUS }, sign);
    const answer = await client.send(second.bytes);

    assert.match(answer, /^error equivocation at tick 60:/,
      `expected the refusal to name equivocation, got "${answer}"`);
    assert.ok(answer.includes(toHex(first.id)) && answer.includes(toHex(second.id)),
      'the refusal must name both ids, so the message itself is the proof');
    assert.equal((await marks(node.port, rid, eid)).count, 1, 'nothing may be stored twice at one tick');
  } finally { client.close(); await node.close(); }
});

test('a mark naming a parent that is not the head is refused', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    assert.equal((await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 })).answer,
                 'receipted');

    // The head has moved on; this one still chains to the start of the round.
    const orphan = await markState(core, driven(120),
      { roundId: rid, entryId: eid, tick: 120, previousHash: NO_PREVIOUS }, sign);
    const answer = await client.send(orphan.bytes);

    assert.equal(answer, 'error the checkpoint does not follow the chain head');
    assert.equal((await marks(node.port, rid, eid)).count, 1);
  } finally { client.close(); await node.close(); }
});

/**
 * A REFUSAL MUST NOT MOVE THE CLIENT'S HEAD.
 *
 * The first version of this test sent the refused mark AROUND the client, on
 * the raw socket, and then asserted that the next one still landed - which it
 * did whatever the client did with its head, because the client had never
 * been asked to make the refused mark. A client that advanced its head on
 * every attempt passed it. So the refusal goes THROUGH the client here, and
 * the check is that the round can carry on afterwards: a head left pointing at
 * a mark nobody stored would have every later checkpoint refused for a reason
 * that has nothing to do with it.
 *
 * The refusal used is a tick going backwards, which the node names, because it
 * is the one a client can produce by accident - a resend after a reconnect.
 */
test('a refusal does not move the client\'s chain head', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const stored = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(stored.answer, 'receipted');
    assert.equal(carry(client, stored), 5, 'the mark has to be live before the head moves');

    const backwards = await client.checkpoint(driven(30), { roundId: rid, entryId: eid, tick: 30 });
    assert.equal(backwards.answer, 'error expected a tick after 60, got 30');
    assert.equal((await marks(node.port, rid, eid)).count, 1, 'the refused mark must not be stored');

    const next = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    assert.equal(next.answer, 'receipted',
      'a refusal left the client chaining onto a parent the node never stored');
    assert.equal((await marks(node.port, rid, eid)).count, 2);

    // and the second one names the first, so the chain the node holds is a chain
    const got = await marks(node.port, rid, eid);
    const second = decodeCheckpoint(splitSigned(got.bytes.slice(SIGNED_CHECKPOINT_BYTES)).body);
    assert.deepEqual(second.previousHash, stored.id, 'the stored chain does not link');
  } finally { client.close(); await node.close(); }
});


/**
 * THE IDS ARE THE CLIENT'S OWN, NOT THE NODE'S WORD FOR THEM.
 *
 * A round id is the tagged hash of a contract the client wrote, so it can
 * compute it and has no reason to be told it. Taking the node's answer would
 * file every mark of the round under an id the player cannot show belongs to
 * their contract, and a node is not trusted here - that is the whole premise.
 *
 * A stub that answers 201 with the wrong thirty-two bytes stands in for that,
 * because a real node cannot be made to lie without changing it.
 */
test('a node that names a different round is a disagreement, not an id', async () => {
  const liar = createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from(b32(99)));
  });
  await new Promise((r) => liar.listen(0, '127.0.0.1', r));
  const port = liar.address().port;
  try {
    const client = new Client({ base: `http://127.0.0.1:${port}`, core, sign, verify });
    const c = contract();
    await assert.rejects(
      () => client.openRound(c),
      (e) => {
        assert.match(e.message, /^the node calls this round /);
        assert.ok(e.message.includes(toHex(roundId(c))),
          'the refusal must name the id the contract actually hashes to');
        return true;
      });

    const e = entryFor(roundId(c));
    await assert.rejects(
      () => client.join(e),
      (err) => {
        assert.match(err.message, /^the node calls this entry /);
        assert.ok(err.message.includes(toHex(entryId(e))));
        return true;
      });
  } finally { await new Promise((r) => liar.close(r)); }
});

/**
 * THE THREE WAYS A RECEIPT CAN BE WRONG, and each one is refused by its own
 * name.
 *
 * A real node signs correctly, so these are built by hand: the client's rule
 * is what is under test, not the node's honesty. Which matters, because the
 * whole point of a receipt is that it is worth something LATER - section 12
 * puts `receipts[]` in the round record and section 13B builds its proof out
 * of signed objects - so a client that accepted a receipt for another mark, or
 * one from a key that is not on the committee, would be collecting evidence
 * that proves nothing.
 *
 * Reported as three failures and not one on purpose: a single "bad receipt"
 * would hide which of them happened, and they are not the same accusation.
 */
test('a receipt for another mark, a stranger, or a bad signature are three different refusals', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const sent = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(sent.answer, 'receipted');

    const nodeKey = node.round.identity;
    const forge = (r, key = nodeKey.secret) =>
      joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), key));
    const now = 1788770000000n;

    // 1. the right node, the right signature, the WRONG mark
    const elsewhere = forge({ checkpointId: b32(0x77), receivedAtMs: now, nodePubkey: nodeKey.pubkey });
    assert.throws(() => client.readReceipt(elsewhere, sent.id), (e) => {
      assert.match(e.message, /^the receipt is for 7777/);
      assert.ok(e.message.includes(toHex(sent.id)), 'the mark actually sent must be named');
      return true;
    });

    // 2. a real signature over a real receipt, by somebody who is not on the
    //    committee this round's contract names
    const stranger = ed25519.utils.randomSecretKey();
    const strangerKey = schnorr.getPublicKey(stranger);
    const outsider = forge({ checkpointId: sent.id, receivedAtMs: now, nodePubkey: strangerKey }, stranger);
    assert.throws(() => client.readReceipt(outsider, sent.id), (e) => {
      assert.match(e.message, /is not on this round's committee$/);
      assert.ok(e.message.includes(toHex(strangerKey)));
      return true;
    });

    // 3. the committee's key claimed, and a signature that does not verify
    //    under it - which is what a forgery looks like from the outside
    const claimed = { checkpointId: sent.id, receivedAtMs: now, nodePubkey: nodeKey.pubkey };
    const lie = joinSignedReceipt(encodeCheckpointReceipt(claimed), schnorr.sign(receiptId(claimed), stranger));
    assert.throws(() => client.readReceipt(lie, sent.id),
      /does not verify under its own key$/);

    // and a truncated one is refused before any of that is read
    assert.throws(() => client.readReceipt(lie.subarray(0, 100), sent.id),
      /a receipt is 139 bytes, the node sent 100/);
  } finally { client.close(); await node.close(); }
});

/**
 * A RE-SENT MARK GETS THE SAME RECEIPT, byte for byte and time for time.
 *
 * Re-sending is what a client does when it never learned the first one
 * landed. Section 10's claim is that the player committed to that state at
 * approximately that real time, and a second receipt with a later timestamp
 * would hand the player two times for one commitment - so the node keeps the
 * receipt and re-serves it rather than making a new one.
 */
test('re-sending a mark returns the receipt already issued, not a second one', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const st = driven(90);
    const first = await client.checkpoint(st, { roundId: rid, entryId: eid, tick: 90 });
    assert.equal(first.answer, 'receipted');

    // the same mark again: the head has moved, so it is rebuilt by hand with
    // the parent it actually had
    const again = await markState(core, st,
      { roundId: rid, entryId: eid, tick: 90, previousHash: NO_PREVIOUS }, sign);
    assert.deepEqual(again.id, first.id, 'the same mark must have the same id');

    const answer = await client.send(again.bytes);
    assert.equal(answer.length, SIGNED_RECEIPT_BYTES);
    const r = decodeCheckpointReceipt(splitSignedReceipt(answer).body);
    assert.equal(r.receivedAtMs, first.receipt.receivedAtMs,
      'a repeat was given a fresh time, so the player now has two for one commitment');
    assert.deepEqual(r.checkpointId, first.id);
  } finally { client.close(); await node.close(); }
});

/**
 * A CLIENT THAT COMES BACK CAN GET ITS RECEIPTS AGAIN.
 *
 * It can rebuild every mark it sent - it made them - but not a signature over
 * one. Before `/receipts` existed, a dropped socket lost them for good, and a
 * receipt that cannot be recovered is not evidence of anything later.
 */
test('a reconnecting client recovers the same receipts, byte for byte', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    client.close();

    // a NEW client, as a reconnect is: it holds the contract, so it knows the
    // committee, and it knows nothing else about what it was given
    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey, ...peerKeys];
    const got = await back.recoverReceipts({ roundId: rid, entryId: eid });

    assert.equal(got.length, 2);
    // AND A RECOVERED RECEIPT COUNTS TOWARDS THE FIVE. A client that came back
    // and had to start its counting from nothing would need the whole
    // committee to receipt every mark a second time, which is not what 13C
    // asks and not what a reconnect is.
    assert.equal(back.witnessed(first.id), 1);
    assert.equal(back.live(first.id), false, 'one recovered receipt is not a quorum');
    assert.deepEqual(got[0].receipt.checkpointId, first.id);
    assert.deepEqual(got[1].receipt.checkpointId, second.id);
    assert.equal(got[0].receipt.receivedAtMs, first.receipt.receivedAtMs,
      'the recovered receipt is not the one that was issued');
    assert.equal(got[0].bytes.length, SIGNED_RECEIPT_BYTES);
  } finally { await node.close(); }
});

/**
 * GOSSIP ACROSS TWO REAL NODES, over the wire.
 *
 * One node takes the mark and receipts it; the other is on the same committee
 * and is offered that receipt on its own /play socket. It keeps it only after
 * the three checks, and a client can then recover it from EITHER of them -
 * which is the point of gossip: the evidence outlives the one connection it
 * was made on.
 */
test('a receipt gossiped to a second node is recoverable from that node too', async () => {
  const one = await serve(openStore(), { port: 0, ...FUNDED });
  const two = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const committee = [one.round.pubkey, two.round.pubkey];
    const c = { ...contract(), nodes: committee };
    const e = entryFor(roundId(c));

    // both nodes hold the round and the entry, and both SEATED it: since
    // letter 26 a committee member reads its committee from the seats the
    // census gave, not from the contract it was handed.
    for (const n of [one, two]) {
      const base = `http://127.0.0.1:${n.port}`;
      await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
      await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(e) });
      assumeSeated(n.round, roundId(c), committee);
    }

    const client = new Client({ base: `http://127.0.0.1:${one.port}`, core, sign, verify });
    client.nodes = committee;
    await client.connect();
    await inputs(client, roundId(c), entryId(e));
    const sent = await client.checkpoint(driven(60),
      { roundId: roundId(c), entryId: entryId(e), tick: 60 });
    assert.equal(sent.answer, 'receipted');
    client.close();

    // the mark has to reach the second node before a receipt for it can, or
    // there is nothing there for the receipt to be about
    const gossip = new Client({ base: `http://127.0.0.1:${two.port}`, core, sign, verify });
    gossip.nodes = committee;
    await gossip.connect();
    await inputs(gossip, roundId(c), entryId(e));
    const mine = await gossip.checkpoint(driven(60),
      { roundId: roundId(c), entryId: entryId(e), tick: 60 });
    assert.deepEqual(mine.id, sent.id, 'the same mark must have the same id on both nodes');

    // now the first node's receipt is offered to the second
    const offered = one.round.receiptFor(sent.id);
    assert.equal(await gossip.send(offered), 'held');
    assert.equal(two.round.receiptCount(sent.id), 2,
      'the second node should hold its own and the gossiped one');
    gossip.close();

    // and a client can recover both from the second node
    const back = new Client({ base: `http://127.0.0.1:${two.port}`, core, sign, verify });
    back.nodes = committee;
    const got = await back.recoverReceipts({ roundId: roundId(c), entryId: entryId(e) });
    assert.equal(got.length, 2);
    assert.ok(got.some((g) => toHex(g.bytes) === toHex(offered)),
      'the gossiped receipt did not come back byte for byte');
  } finally { await one.close(); await two.close(); }
});

/**
 * AND WHAT COMES BACK FROM /receipts IS CHECKED, not taken.
 *
 * A recovered receipt is the evidence a player will still be holding at
 * settlement. A client that verified the ones handed to it live and then
 * swallowed whatever a reconnect returned would be trusting the node exactly
 * where it matters most - after the connection it was made on is gone.
 *
 * A real node cannot be made to serve a bad one, so this is a stub, the same
 * way the round-id disagreement is.
 */
test('a recovered receipt that does not verify, or is from a stranger, is refused', async () => {
  const nodeKey = ed25519.utils.randomSecretKey();
  const nodePubkey = schnorr.getPublicKey(nodeKey);
  const stranger = ed25519.utils.randomSecretKey();

  let serve139 = null;
  const stub = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from(serve139));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  const at = (base) => {
    const c = new Client({ base, core, sign, verify });
    c.nodes = [nodePubkey];
    return c;
  };
  const where = { roundId: b32(1), entryId: b32(2) };

  try {
    // 1. the committee's key claimed, signed by somebody else
    const claimed = { checkpointId: b32(3), receivedAtMs: 1788770000000n, nodePubkey };
    serve139 = joinSignedReceipt(encodeCheckpointReceipt(claimed),
                                 schnorr.sign(receiptId(claimed), stranger));
    await assert.rejects(() => at(`http://127.0.0.1:${port}`).recoverReceipts(where),
      /does not verify under its own key$/);

    // 2. an honest receipt from somebody who is not on the committee
    const outsiderKey = schnorr.getPublicKey(stranger);
    const outsider = { checkpointId: b32(3), receivedAtMs: 1788770000000n, nodePubkey: outsiderKey };
    serve139 = joinSignedReceipt(encodeCheckpointReceipt(outsider),
                                 schnorr.sign(receiptId(outsider), stranger));
    await assert.rejects(() => at(`http://127.0.0.1:${port}`).recoverReceipts(where),
      /is not on this round's committee$/);

    // 3. and a body that is not a whole number of receipts
    serve139 = new Uint8Array(200);
    await assert.rejects(() => at(`http://127.0.0.1:${port}`).recoverReceipts(where),
      /200 bytes is not a whole number of 139-byte receipts/);
  } finally { await new Promise((r) => stub.close(r)); }
});

/* --------------------------------------------------------- the batch chain */

/** Two hundred ticks of nothing in particular, in the units `step` takes. */
const rolling = (n) => Array.from({ length: n }, (_, i) => [45875, 0, 0, 0, 0]);

/**
 * A DROPPED SOCKET MUST NOT LOSE WHAT WAS ALREADY PUBLISHED.
 *
 * Section 11 hash-chains the inputs and leaves publishing to the client: the
 * daemon never asks for a retransmission, and unpublished inputs cost the
 * player the run. So a reconnecting client does not want its batches BACK - it
 * has them - it wants the two numbers that let it carry on: the tick the node
 * is owed next and the head to hang it off.
 *
 * Measured before this existed: /transcript already served 8287 bytes and 400
 * ticks, and nothing in the client asked for any of it or checked a byte.
 */
test('a client that reconnects carries on from the tick the node is owed', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    assert.equal(client.nextTick, 0, 'a fresh client owes the round from its start');
    const one = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(one.accepted, 200);
    const two = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(two.accepted, 200);
    assert.equal(client.nextTick, 400);

    // a mark as well, so the OTHER chain has a head to recover too
    const mark = await client.checkpoint(driven(400),
      { roundId: rid, entryId: eid, tick: 400, inputChainHash: two.batch ? batchId(two.batch) : GENESIS });
    assert.equal(mark.answer, 'receipted');
    // four more committee members receipt it, and the node keeps them, so the
    // mark is live for whoever comes back and recovers them
    await gossipCarry(client, mark);
    client.close();

    // the socket drops and a new client comes back knowing only the contract
    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey, ...peerKeys];
    assert.equal(back.nextTick, 0, 'and it starts knowing nothing about the round');

    const got = await back.resume({ roundId: rid, entryId: eid });
    assert.equal(got.batches, 2);
    assert.equal(got.ticks, 400);
    assert.equal(got.nextTick, 400, 'the node is owed tick 400 next');
    assert.deepEqual(got.batchHead, client.batchHead, 'the input chain head is not the one published');
    assert.deepEqual(got.head, mark.id, 'the mark chain head is not the one published');
    assert.equal(got.receipts, 5);
    assert.equal(got.witnessed, 5, 'the head was adopted on fewer than five');
    assert.equal(got.live, true);

    // and it can carry on: the next batch and the next mark are both accepted,
    // which is the whole point - a wrong head or a wrong tick is refused.
    await back.connect();
    const three = await back.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(three.accepted, 200, `the node refused the batch after a resume: ${three.answer}`);
    const next = await back.checkpoint(driven(600), { roundId: rid, entryId: eid, tick: 600,
      inputChainHash: batchId(three.batch) });
    assert.equal(next.answer, 'receipted', `the node refused the mark after a resume: ${next.answer}`);
    back.close();
  } finally { await node.close(); }
});

/**
 * A REFUSED BATCH DOES NOT MOVE THE CLIENT'S CHAIN, for the same reason a
 * refused mark does not: the next one would hang off a head nobody has.
 */
test('a batch the node refuses leaves the client where it was', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await client.batch(rolling(200), { roundId: rid, entryId: eid });
    const head = client.batchHead, tick = client.nextTick;

    // a gap: the node names the tick it is owed and stores nothing
    client.nextTick = 400;
    const gap = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.match(gap.answer, /^error /, `expected a refusal, got ${gap.answer}`);
    assert.deepEqual(client.batchHead, head, 'a refusal moved the input chain head');

    client.nextTick = tick;
    const good = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(good.accepted, 200, 'the client could not carry on after a refusal');
  } finally { client.close(); await node.close(); }
});

/**
 * AND A TRANSCRIPT IS CHECKED, NOT TAKEN.
 *
 * The node checks the chain before it serves, which is exactly why the client
 * checks it again: resuming from a head a node made up would build every later
 * batch onto a history nobody has, and the player would find out at
 * settlement. A real node will not serve a broken one, so this is a stub.
 *
 * There is no signature to check - an InputBatch carries none in this
 * protocol, the chain hash is its integrity - and none is invented here.
 */
test('a transcript for another round, or a broken chain, is refused by name', async () => {
  let body = null;
  const stub = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from(body));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const back = () => new Client({ base: `http://127.0.0.1:${port}`, core, sign, verify });
  const rid = b32(1), eid = b32(2);
  const batchOf = (roundId, entryId, previousHash, firstTick) => ({
    roundId, entryId, previousHash, firstTick, ticks: rolling(10), liquidations: [],
  });

  try {
    // 1. a transcript about somebody else's round
    body = encodeTranscript({ roundId: b32(9), entryId: eid,
      batches: [batchOf(b32(9), eid, GENESIS, 0)] });
    await assert.rejects(() => back().resume({ roundId: rid, entryId: eid }),
      /the transcript is for round 0909/);

    // 2. the right round, a chain that does not link
    body = encodeTranscript({ roundId: rid, entryId: eid, batches: [
      batchOf(rid, eid, GENESIS, 0),
      batchOf(rid, eid, b32(0x77), 10),        // names a parent nobody has
    ] });
    await assert.rejects(() => back().resume({ roundId: rid, entryId: eid }),
      /the transcript is broken at batch 1: the chain is broken here/);

    // 3. bytes that are not a transcript at all
    body = new Uint8Array(40);
    await assert.rejects(() => back().resume({ roundId: rid, entryId: eid }),
      /the transcript will not decode: /);
  } finally { await new Promise((r) => stub.close(r)); }
});

/**
 * A DROPPED SOCKET IS TOLD ABOUT, and nothing is left waiting for an answer
 * that can no longer arrive.
 *
 * A publish that never settles stops the queue behind it for the rest of the
 * run, so everything in flight is answered by name when the socket goes - in
 * the same shape a refusal takes, because a caller that already handles "the
 * node said no" then handles this too without a second path.
 */
test('when the socket goes, what was in flight is answered and the owner is told', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    let dropped = 0;
    client.onDrop = () => { dropped++; };

    await client.batch(rolling(200), { roundId: rid, entryId: eid });
    client.close();
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(dropped, 1, 'the owner was not told the socket had gone');
    const after = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(after.answer, 'error there is no socket',
      'a send on a dead socket must answer, not throw');
    assert.equal(client.nextTick, 200, 'and it must not move the chain');
  } finally { await node.close(); }
});

/**
 * AND THE CLIENT CAN COME BACK ON A NEW SOCKET and carry on, which is what a
 * reconnect is: the same client, a fresh connection, both chains read back off
 * the node, and the next batch and mark accepted.
 */
test('a client that reconnects on the same round carries on', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await client.batch(rolling(200), { roundId: rid, entryId: eid });
    const mark = await client.checkpoint(driven(200), { roundId: rid, entryId: eid, tick: 200 });
    assert.equal(mark.answer, 'receipted');
    await gossipCarry(client, mark);          // and the committee carries it

    client.close();
    await new Promise((r) => setTimeout(r, 200));

    // the same client, a new socket, and the two numbers read back
    await client.connect();
    const got = await client.resume({ roundId: rid, entryId: eid });
    assert.equal(got.nextTick, 200);
    assert.deepEqual(got.head, mark.id);
    assert.equal(got.witnessed, 5);

    const next = await client.batch(rolling(200), { roundId: rid, entryId: eid });
    assert.equal(next.accepted, 200, `the node refused the batch after a reconnect: ${next.answer}`);
    const after = await client.checkpoint(driven(400), { roundId: rid, entryId: eid, tick: 400 });
    assert.equal(after.answer, 'receipted', `the node refused the mark after a reconnect: ${after.answer}`);
  } finally { client.close(); await node.close(); }
});

/**
 * A MARK IS LIVE AT FIVE, NOT AT ONE.
 *
 * The head used to move on the first verified receipt - true as far as it went
 * and thinner than it sounded, because 13C makes the canonical transcript "the
 * longest checkpoint chain that carries receipts from at least 5 committee
 * nodes". Between one and four a mark is witnessed by somebody and carried by
 * nobody, and building the next mark onto it would put the run on a link that
 * can never be canonical - which is how an operator with a short committee
 * gets paid for one.
 *
 * PENDING IS NOT FAILED. Nothing here voids a run or loses it for a player.
 * What happens to a run whose marks never reach five is the no-quorum rule,
 * it decides FORFEIT against VOID, and it is settlement rather than a client.
 */
test('a mark is live at five distinct committee receipts, and pending below', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    assert.equal(RECEIPTS_FOR_LIVE, 5);

    // 0: nothing has been sent, so nothing is witnessed and the head is where
    // a round starts
    const before = client.head;
    assert.deepEqual(before, NO_PREVIOUS);

    const mark = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(mark.answer, 'receipted');

    // 1: the node that stored it has receipted it, and that is not five
    assert.equal(client.witnessed(mark.id), 1);
    assert.equal(client.live(mark.id), false);
    assert.deepEqual(client.head, before, 'one receipt moved the head');

    // 4: three more committee members, still pending
    for (let i = 0; i < 3; i++) {
      client.readReceipt(receiptFrom(peers[i], mark.id, 2000n + BigInt(i)), mark.id);
    }
    assert.equal(client.witnessed(mark.id), 4);
    assert.equal(client.live(mark.id), false);
    assert.deepEqual(client.head, before, 'four receipts moved the head');

    // 5: the threshold, and only now does the head move
    client.readReceipt(receiptFrom(peers[3], mark.id, 2003n), mark.id);
    assert.equal(client.witnessed(mark.id), 5);
    assert.equal(client.live(mark.id), true);
    assert.deepEqual(client.head, mark.id);

    // 7: the whole committee, and it is the same one head
    client.readReceipt(receiptFrom(peers[4], mark.id, 2004n), mark.id);
    client.readReceipt(receiptFrom(peers[5], mark.id, 2005n), mark.id);
    assert.equal(client.witnessed(mark.id), 7);
    assert.equal(client.live(mark.id), true);
    assert.deepEqual(client.head, mark.id, 'the head moved twice for one mark');
  } finally { client.close(); await node.close(); }
});

/**
 * FIVE RECEIPTS FROM ONE NODE IS ONE NODE SAYING IT FIVE TIMES. 13C counts
 * committee NODES, so the count is over distinct signers - and a receipt that
 * fails any of the three checks does not count at all, because a client that
 * counted what it could not verify would be counting the operator's word.
 */
test('the same signer five times is one, and an unverifiable receipt is none', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const mark = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(client.witnessed(mark.id), 1);

    // the same committee member, over and over
    for (let i = 0; i < 5; i++) {
      client.readReceipt(receiptFrom(peers[0], mark.id, 3000n + BigInt(i)), mark.id);
    }
    assert.equal(client.witnessed(mark.id), 2, 'one signer counted more than once');
    assert.equal(client.live(mark.id), false);

    // a stranger who is not on the committee
    const stranger = ed25519.utils.randomSecretKey();
    assert.throws(() => client.readReceipt(receiptFrom(stranger, mark.id, 4000n), mark.id),
      /is not on this round's committee/);

    // a committee member's key claimed, signed by somebody else
    const forged = joinSignedReceipt(
      encodeCheckpointReceipt({ checkpointId: mark.id, nodePubkey: peerKeys[1], receivedAtMs: 5000n }),
      ed25519.sign(b32(1), stranger));
    assert.throws(() => client.readReceipt(forged, mark.id), /does not verify under its own key/);

    // and an honest receipt for a different mark
    const elsewhere = receiptFrom(peers[1], b32(0x7e), 6000n);
    assert.throws(() => client.readReceipt(elsewhere, mark.id), /the receipt is for /);

    assert.equal(client.witnessed(mark.id), 2, 'a refused receipt was counted');
    assert.equal(client.live(mark.id), false);
    assert.deepEqual(client.head, NO_PREVIOUS);
  } finally { client.close(); await node.close(); }
});

/**
 * AND THE RESUME PATH COUNTS TO FIVE TOO.
 *
 * The rule landed in `readReceipt` and was missing one function away. `resume`
 * set the head to whatever mark the node happened to hold last, on that node's
 * word alone - so a run that lost its socket came back chaining onto a mark
 * four committee members had never seen, which is exactly what an operator
 * with a short committee needs.
 *
 * A disconnect is not an escape hatch either: when nothing recovered is live
 * the head stays where the client can prove it belongs and the run carries on,
 * rather than the session being refused.
 */
test('a reconnect adopts a head only at five, and never the node s last mark', async () => {
  for (const carried of [0, 3, 4]) {
    const { node, client, rid, eid } = await rig();
    try {
      await client.batch(rolling(200), { roundId: rid, entryId: eid });
      const mark = await client.checkpoint(driven(200),
        { roundId: rid, entryId: eid, tick: 200 });
      assert.equal(mark.answer, 'receipted');
      await gossipCarry(client, mark, carried);   // 1, 4 or 5 on the node
      client.close();

      const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
      back.nodes = [node.round.pubkey, ...peerKeys];
      const before = back.head;
      assert.deepEqual(before, NO_PREVIOUS);

      const got = await back.resume({ roundId: rid, entryId: eid });
      assert.equal(got.receipts, carried + 1, 'the node did not hold what was gossiped to it');
      if (carried + 1 < 5) {
        // 1 and 4: the node holds a mark, and it is not the head
        assert.equal(got.live, false);
        assert.equal(got.witnessed, 0);
        assert.deepEqual(got.head, before,
          `resume adopted a head on ${carried + 1} receipts`);
        assert.deepEqual(back.head, NO_PREVIOUS);
        // and the run is not refused - the client is still told where to carry on
        assert.equal(got.nextTick, 200);
      } else {
        assert.equal(got.live, true);
        assert.equal(got.witnessed, 5);
        assert.deepEqual(got.head, mark.id);
      }
      assert.equal(back.witnessed(mark.id), carried + 1,
        'recovered receipts did not count towards the mark');
    } finally { await node.close(); }
  }
});

/** The last LIVE mark is adopted, not the last mark. */
test('a reconnect walks back to the newest mark five members carried', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first);           // five: this one is carried
    carry(client, first);                       // and the client knows it, so it can chain on
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    assert.equal(second.answer, 'receipted');   // one receipt only
    client.close();

    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey, ...peerKeys];
    const got = await back.resume({ roundId: rid, entryId: eid });

    assert.equal(got.receipts, 6, 'five for the first mark and one for the second');
    assert.deepEqual(got.head, first.id, 'the newest mark was adopted, not the newest LIVE one');
    assert.notDeepEqual(got.head, second.id);
    assert.equal(back.witnessed(first.id), 5);
    assert.equal(back.witnessed(second.id), 1);
    assert.equal(back.live(second.id), false);
  } finally { await node.close(); }
});

/**
 * AND WITH TWO LIVE MARKS IT IS THE NEWEST, not the first one that qualifies.
 * Adopting the oldest live mark would republish everything after it and read
 * as correct, which is why it is measured rather than assumed.
 */
test('a reconnect adopts the NEWEST live mark, not the oldest', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    await inputs(client, rid, eid);
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    await gossipCarry(client, first);
    carry(client, first);
    const second = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    await gossipCarry(client, second);          // both are carried by five
    carry(client, second);
    const third = await client.checkpoint(driven(180), { roundId: rid, entryId: eid, tick: 180 });
    assert.equal(third.answer, 'receipted');    // and this one by one
    client.close();

    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey, ...peerKeys];
    const got = await back.resume({ roundId: rid, entryId: eid });

    assert.equal(back.witnessed(first.id), 5);
    assert.equal(back.witnessed(second.id), 5);
    assert.equal(back.witnessed(third.id), 1);
    assert.deepEqual(got.head, second.id, 'the oldest live mark was adopted, not the newest');
    assert.notDeepEqual(got.head, first.id);
    assert.notDeepEqual(got.head, third.id);
  } finally { await node.close(); }
});
