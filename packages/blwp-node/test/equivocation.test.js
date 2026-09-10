// SECTION 13B: THE PLAYER WHO SIGNED TWO WORLDS AT ONE TICK.
//
// "A player who publishes two different checkpoints for the same
// (round_id, player_pubkey, tick), or two chains that diverge at any tick,
// forfeits the entry... The two conflicting signed checkpoints are a complete,
// portable proof; no replay is needed. Nodes MUST publish such a proof when
// they hold one."
//
// The node already REFUSED the second mark and then threw it away, which
// destroyed the only thing that shows what the player did. It is kept now, and
// the proof is checkable by anyone holding the two records - no node asked, no
// transcript replayed, no committee needed. That is why this is the one part of
// the no-quorum rule a single node can hold up on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned,
  splitSigned, provesEquivocation, SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import {
  encodeCheckpointReceipt, decodeCheckpointReceipt, receiptId, joinSignedReceipt,
  splitSignedReceipt,
} from '../../protocol/src/receipt.js';
import { toHex } from '../../protocol/src/hash.js';
import { decodeEntryContract } from '../../protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const verify = (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } };

const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
});
const signedBy = (c, key = session) =>
  joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), key));

/** A round with one mark at tick 60, and the pieces to conflict with it. */
function played() {
  const round = new Round(openStore(), () => 1234);
  const c = contract([b32(4)]);
  const rid = round.open(c);
  const eid = round.enter(entryFor(rid));
  // THE INPUTS FIRST, as a client sends them: a node refuses a checkpoint at a
  // tick whose inputs it does not hold, and every mark here is at 240 or less.
  round.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 400 }, (_, i) => [65536, i, 0, 0, 0]), liquidations: [],
  }));
  const mark = {
    roundId: rid, entryId: eid, tick: 60, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(signedBy(mark));
  return { round, rid, eid, mark };
}

test('the second world is refused and KEPT, where it used to be thrown away', () => {
  const { round, rid, eid, mark } = played();
  assert.deepEqual(round.equivocation(rid, eid), []);

  const other = { ...mark, stateHash: b32(0x22) };
  assert.throws(() => round.checkpoint(signedBy(other)), /equivocation at tick 60/);

  const held = round.equivocation(rid, eid);
  assert.equal(held.length, 1);
  assert.equal(held[0].tick, 60);
  assert.equal(held[0].stored.length, SIGNED_CHECKPOINT_BYTES);
  assert.equal(held[0].offered.length, SIGNED_CHECKPOINT_BYTES);
  assert.notEqual(toHex(held[0].stored), toHex(held[0].offered));

  // and the chain the committee carries is untouched: one checkpoint, the first
  const kept = round.checkpoints(rid, eid);
  assert.equal(kept.count, 1);
  assert.deepEqual(
    checkpointId(decodeCheckpoint(splitSigned(kept.bytes).body)),
    checkpointId(mark));
});

/**
 * AND ANYONE CAN CHECK IT. The two records and the session key the entry
 * named, and nothing else: no node is asked and no transcript is replayed.
 */
test('the two records prove it on their own', async () => {
  const { round, rid, eid, mark } = played();
  const other = { ...mark, stateHash: b32(0x22) };
  assert.throws(() => round.checkpoint(signedBy(other)), /equivocation/);
  const [held] = round.equivocation(rid, eid);

  const seen = await provesEquivocation(held.stored, held.offered, sessionPubkey, verify);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.tick, 60);
  assert.equal(seen.ids.length, 2);
  assert.notEqual(toHex(seen.ids[0]), toHex(seen.ids[1]));
});

/**
 * WHAT IS NOT EQUIVOCATION, and each of these would take a stake if it were.
 */
test('a repeat, another tick, another entry and a forgery are all refused', async () => {
  const { round, rid, eid, mark } = played();
  const mine = signedBy(mark);

  // the same mark twice is the ordinary case - a dropped socket, a re-send
  const same = await provesEquivocation(mine, mine, sessionPubkey, verify);
  assert.equal(same.ok, false);
  assert.match(same.why, /the same mark, sent twice/);

  // two marks at different ticks that name different parents ARE a chain: the
  // second follows the first, which is what playing a round looks like
  const later = signedBy({
    ...mark, tick: 120, stateHash: b32(0x33), previousHash: checkpointId(mark),
  });
  const ticks = await provesEquivocation(mine, later, sessionPubkey, verify);
  assert.equal(ticks.ok, false);
  assert.match(ticks.why, /at ticks 60 and 120 and name different parents/);

  // and two marks from different entries are two players
  const elsewhere = signedBy({ ...mark, entryId: b32(0x7e), stateHash: b32(0x44) });
  const other = await provesEquivocation(mine, elsewhere, sessionPubkey, verify);
  assert.equal(other.ok, false);
  assert.match(other.why, /not from the same entry/);

  // A FORGERY MUST NOT FORFEIT A STAKE. Anyone can write two conflicting
  // objects; only the session key the entry named can sign them.
  const stranger = ed25519.utils.randomSecretKey();
  const forged = signedBy({ ...mark, stateHash: b32(0x55) }, stranger);
  const fake = await provesEquivocation(mine, forged, sessionPubkey, verify);
  assert.equal(fake.ok, false);
  assert.match(fake.why, /the second mark is not signed by that entry/);

  const both = await provesEquivocation(forged, mine, sessionPubkey, verify);
  assert.equal(both.ok, false);
  assert.match(both.why, /the first mark is not signed by that entry/);

  // and bytes that are not a signed checkpoint at all
  const rubbish = await provesEquivocation(mine.slice(0, 20), mine, sessionPubkey, verify);
  assert.equal(rubbish.ok, false);
  assert.match(rubbish.why, /not a signed checkpoint/);

  assert.equal(round.equivocation(rid, eid).length, 0, 'nothing above should have been stored');
});

test('the node publishes the proof it holds, and says so when it holds none', async () => {
  const clean = played();
  const guilty = played();
  const other = { ...guilty.mark, stateHash: b32(0x22) };
  assert.throws(() => guilty.round.checkpoint(signedBy(other)), /equivocation/);

  const a = await serve(guilty.round.db, { port: 0, funded: () => true });
  const b = await serve(clean.round.db, { port: 0, funded: () => true });
  try {
    const at = (p, r, e) =>
      fetch(`http://127.0.0.1:${p}/equivocation?round=${toHex(r)}&entry=${toHex(e)}`);

    const found = await at(a.port, guilty.rid, guilty.eid);
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('x-equivocations'), '1');
    assert.equal(found.headers.get('x-ticks-at'), '60');
    const body = new Uint8Array(await found.arrayBuffer());
    assert.equal(body.length, 2 * SIGNED_CHECKPOINT_BYTES);

    // and what comes off the wire proves it, without asking that node anything
    const seen = await provesEquivocation(
      body.subarray(0, SIGNED_CHECKPOINT_BYTES),
      body.subarray(SIGNED_CHECKPOINT_BYTES), sessionPubkey, verify);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.tick, 60);

    const none = await at(b.port, clean.rid, clean.eid);
    assert.equal(none.status, 204);
  } finally { await a.close(); await b.close(); }
});

/**
 * THE SECOND LIMB: TWO CHAINS THAT DIVERGE AT ANY TICK.
 *
 * 13B is "two different checkpoints for the same (round_id, player_pubkey,
 * tick), OR two chains that diverge at any tick". The first is a contradiction
 * at one tick; the second is a FORK - a chain has one child per parent, so two
 * marks naming the same parent are two chains whatever ticks they sit at. Both
 * are provable from the two records alone, which is what portable means.
 *
 * This is what the split-committee attack leaves behind: chain A to three
 * nodes, chain B to four, every node locally consistent, and the two records
 * only meeting when somebody brings them together.
 */
test('two marks naming one parent are two chains, at whatever ticks', async () => {
  const { mark } = played();
  const parent = checkpointId(mark);

  // the player builds two children on one parent, at different ticks
  const a = signedBy({ ...mark, tick: 120, stateHash: b32(0xa1), previousHash: parent });
  const b = signedBy({ ...mark, tick: 180, stateHash: b32(0xb2), previousHash: parent });

  const seen = await provesEquivocation(a, b, sessionPubkey, verify);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.how, 'two chains from one parent');
  assert.deepEqual(seen.ticks, [120, 180]);
  assert.notEqual(toHex(seen.ids[0]), toHex(seen.ids[1]));

  // and two first marks of one round are two chains from the start
  const first = signedBy({ ...mark, stateHash: b32(0xc3) });
  const alsoFirst = signedBy({ ...mark, tick: 90, stateHash: b32(0xd4) });
  const start = await provesEquivocation(first, alsoFirst, sessionPubkey, verify);
  assert.equal(start.ok, true, start.why);
  assert.equal(start.how, 'two chains from one parent');

  // the same-tick limb still says what it always said
  const sameTick = await provesEquivocation(
    signedBy(mark), signedBy({ ...mark, stateHash: b32(0xe5) }), sessionPubkey, verify);
  assert.equal(sameTick.ok, true, sameTick.why);
  assert.equal(sameTick.how, 'two marks at one tick');

  // a forgery is still not a forfeit, on either limb
  const stranger = ed25519.utils.randomSecretKey();
  const forged = signedBy({ ...mark, tick: 180, stateHash: b32(0xf6), previousHash: parent },
    stranger);
  const fake = await provesEquivocation(a, forged, sessionPubkey, verify);
  assert.equal(fake.ok, false);
  assert.match(fake.why, /not signed by that entry/);
});

/**
 * THE SPLIT COMMITTEE, on one node. A player sends chain A here and chain B
 * elsewhere; this node holds A, and the only thing that says B exists is a
 * committee member's receipt for a mark this node never got. That receipt used
 * to be dropped at the door.
 */
test('a receipt for a mark this node never got is kept as evidence', () => {
  const { round, rid, eid, mark } = played();
  const elsewhere = { ...mark, tick: 120, stateHash: b32(0x99), previousHash: checkpointId(mark) };
  const theirId = checkpointId(elsewhere);
  const member = ed25519.utils.randomSecretKey();
  const receipt = (() => {
    const r = {
      checkpointId: theirId, nodePubkey: schnorr.getPublicKey(member), receivedAtMs: 7000n,
    };
    return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), member));
  })();

  assert.equal(round.foreignReceipts().length, 0);
  assert.throws(() => round.takeReceipt(receipt), /a receipt for a mark this node has not got/);

  const kept = round.foreignReceipts();
  assert.equal(kept.length, 1, 'the divergence signal was dropped');
  assert.deepEqual(kept[0].checkpointId, theirId);
  assert.deepEqual(kept[0].nodePubkey, schnorr.getPublicKey(member));

  // AND IT IS NOT A VOTE. It counts towards nothing: the mark is not this
  // node's, and receiptCount is about marks this node holds.
  assert.equal(round.receiptCount(checkpointId(mark)), 1);

  // a receipt whose signature does not verify is not evidence of anything
  const rubbish = new Uint8Array(receipt);
  rubbish[rubbish.length - 1] ^= 0xff;
  assert.throws(() => round.takeReceipt(rubbish), /does not verify/);
  assert.equal(round.foreignReceipts().length, 1, 'a bad signature was kept as evidence');
});

/**
 * AND THE SECOND CHAIN ITSELF, brought here by a peer. It is refused - it does
 * not join the chain and it is not a second head - and it is kept, so the two
 * records can be put side by side on one node.
 */
test('a peer s copy of the other chain is refused and kept beside ours', async () => {
  const { round, rid, eid, mark } = played();
  const theirs = { ...mark, tick: 120, stateHash: b32(0x99), previousHash: b32(0x7e) };

  assert.throws(() => round.checkpoint(signedBy(theirs)),
    /the checkpoint does not follow the chain head/);

  const offered = round.offeredMarks(rid, eid);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].tick, 120);

  // the carried chain is untouched: one checkpoint, and it is ours
  assert.equal(round.checkpoints(rid, eid).count, 1);
  assert.deepEqual(
    checkpointId(decodeCheckpoint(splitSigned(round.checkpoints(rid, eid).bytes).body)),
    checkpointId(mark));
});

/**
 * PORTABLE MEANS A STRANGER CAN CHECK IT.
 *
 * 13B: "the two conflicting signed checkpoints are a complete, portable proof;
 * no replay is needed". They are not, on their own: the signatures verify
 * under the entry's session key, and until this node served the entry there
 * was no way to obtain it. Somebody holding the proof could read it and could
 * not check it, which is most of what portable was supposed to buy.
 */
test('a stranger with the proof and the entry can check it, and without the entry cannot', async () => {
  const guilty = played();
  const other = { ...guilty.mark, stateHash: b32(0x22) };
  assert.throws(() => guilty.round.checkpoint(signedBy(other)), /equivocation/);

  const node = await serve(guilty.round.db, { port: 0, funded: () => true });
  try {
    const base = `http://127.0.0.1:${node.port}`;

    // A STRANGER. It holds the entry id and nothing else - no contract, no
    // session key, no transcript, and it never watched the round.
    const proof = await fetch(
      `${base}/equivocation?round=${toHex(guilty.rid)}&entry=${toHex(guilty.eid)}`);
    assert.equal(proof.status, 200);
    const body = new Uint8Array(await proof.arrayBuffer());
    const a = body.subarray(0, SIGNED_CHECKPOINT_BYTES);
    const b = body.subarray(SIGNED_CHECKPOINT_BYTES);

    // without the key there is nothing to verify against, and guessing one
    // answers no - which is the honest failure, not a pass
    const guessed = await provesEquivocation(a, b, b32(0x00), verify);
    assert.equal(guessed.ok, false);
    assert.match(guessed.why, /not signed by that entry/);

    // with the entry door, the key comes off the contract the player signed
    const got = await fetch(`${base}/entry?id=${toHex(guilty.eid)}`);
    assert.equal(got.status, 200);
    const entry = decodeEntryContract(new Uint8Array(await got.arrayBuffer()));
    assert.deepEqual(entry.sessionPubkey, sessionPubkey);

    const seen = await provesEquivocation(a, b, entry.sessionPubkey, verify);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.how, 'two marks at one tick');
    assert.equal(seen.tick, 60);

    // and an entry nobody has is a named 404, not an empty answer
    const missing = await fetch(`${base}/entry?id=${toHex(b32(0x7e))}`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /no such entry/);
  } finally { await node.close(); }
});

/**
 * THE FORK PROOF, PUBLISHED. The node held both records and answered 204.
 *
 * Measured before this: first mark at 60, child A at 120 accepted, child B at
 * 180 on the same parent refused - `equivocations` 0, `offered_marks` 1,
 * GET /equivocation 204. 13B says nodes MUST publish such a proof when they
 * hold one, and this one held it in two tables the door only read one of. The
 * same-tick pair was measured through the door and the fork pair through
 * `provesEquivocation`; nothing crossed them, so nothing caught it.
 */
test('a node that holds a fork proof publishes it, where it used to answer 204', async () => {
  const { round, rid, eid, mark } = played();
  const parent = checkpointId(mark);
  const childA = { ...mark, tick: 120, stateHash: b32(0xa1), previousHash: parent };
  round.checkpoint(signedBy(childA));
  const childB = { ...mark, tick: 180, stateHash: b32(0xb2), previousHash: parent };
  assert.throws(() => round.checkpoint(signedBy(childB)), /does not follow the chain head/);

  // both records are still here, and the chain is untouched
  assert.equal(round.offeredMarks(rid, eid).length, 1);
  assert.equal(round.checkpoints(rid, eid).count, 2);

  const held = round.equivocation(rid, eid);
  assert.equal(held.length, 1, 'the fork proof was held and not published');
  assert.equal(held[0].how, 'two chains from one parent');

  const node = await serve(round.db, { port: 0, funded: () => true });
  try {
    const base = `http://127.0.0.1:${node.port}`;
    const r = await fetch(`${base}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(r.status, 200, 'the door still answers 204 on a fork it holds');
    assert.equal(r.headers.get('x-equivocations'), '1');
    const body = new Uint8Array(await r.arrayBuffer());
    assert.equal(body.length, 2 * SIGNED_CHECKPOINT_BYTES);

    // A STRANGER with only the entry id, and no second format to learn
    const got = await fetch(`${base}/entry?id=${toHex(eid)}`);
    const entry = decodeEntryContract(new Uint8Array(await got.arrayBuffer()));
    const seen = await provesEquivocation(
      body.subarray(0, SIGNED_CHECKPOINT_BYTES),
      body.subarray(SIGNED_CHECKPOINT_BYTES), entry.sessionPubkey, verify);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.how, 'two chains from one parent');
    assert.deepEqual(seen.ticks, [120, 180]);
  } finally { await node.close(); }
});

/** And the same-tick limb still publishes, beside it. */
test('the same-tick proof still publishes, and both are served together', async () => {
  const { round, rid, eid, mark } = played();
  assert.throws(() => round.checkpoint(signedBy({ ...mark, stateHash: b32(0x22) })),
    /equivocation at tick 60/);

  const parent = checkpointId(mark);
  round.checkpoint(signedBy({ ...mark, tick: 120, stateHash: b32(0xa1), previousHash: parent }));
  assert.throws(
    () => round.checkpoint(signedBy({ ...mark, tick: 180, stateHash: b32(0xb2), previousHash: parent })),
    /does not follow the chain head/);

  const held = round.equivocation(rid, eid);
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((h) => h.how).sort(),
    ['two chains from one parent', 'two marks at one tick']);

  const node = await serve(round.db, { port: 0, funded: () => true });
  try {
    const r = await fetch(
      `http://127.0.0.1:${node.port}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(r.headers.get('x-equivocations'), '2');
    assert.equal((await r.arrayBuffer()).byteLength, 4 * SIGNED_CHECKPOINT_BYTES);
  } finally { await node.close(); }
});

/**
 * AND AN HONEST STALE HEAD IS NOT A FORK. A client that re-sends a mark after
 * a drop names a parent that is no longer the head; it is refused and kept,
 * and it must not be published as a proof, because nothing of ours contradicts
 * it. Publishing that would forfeit a stake for a dropped socket.
 */
test('a refused mark that contradicts nothing is not published as a proof', () => {
  const { round, rid, eid, mark } = played();
  const parent = checkpointId(mark);
  round.checkpoint(signedBy({ ...mark, tick: 120, stateHash: b32(0xa1), previousHash: parent }));

  // a mark naming a parent this node has never held at all
  assert.throws(
    () => round.checkpoint(signedBy({ ...mark, tick: 240, stateHash: b32(0xc3), previousHash: b32(0x7e) })),
    /does not follow the chain head/);

  assert.equal(round.offeredMarks(rid, eid).length, 1, 'it was kept, as evidence');
  assert.deepEqual(round.equivocation(rid, eid), [], 'and it was published as a proof');
});

/**
 * THE SPLIT-COMMITTEE SIGNAL, ASKED FOR. A receipt for a mark this node never
 * got is the only thing that surfaces two chains sent to disjoint subsets
 * before settlement, and it was kept where nobody could ask for it.
 */
test('a node publishes the receipts it holds for marks it has not got', async () => {
  const { round, mark } = played();
  const elsewhere = { ...mark, tick: 120, stateHash: b32(0x99), previousHash: checkpointId(mark) };
  const member = ed25519.utils.randomSecretKey();
  const r = {
    checkpointId: checkpointId(elsewhere),
    nodePubkey: schnorr.getPublicKey(member),
    receivedAtMs: 7000n,
  };
  const receipt = joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), member));

  const empty = await serve(played().round.db, { port: 0, funded: () => true });
  const node = await serve(round.db, { port: 0, funded: () => true });
  try {
    // nothing held yet
    const none = await fetch(`http://127.0.0.1:${empty.port}/foreign-receipts`);
    assert.equal(none.status, 204);

    assert.throws(() => round.takeReceipt(receipt), /has not got/);

    const got = await fetch(`http://127.0.0.1:${node.port}/foreign-receipts`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-foreign-receipts'), '1');
    const body = new Uint8Array(await got.arrayBuffer());
    assert.equal(toHex(body), toHex(receipt), 'the bytes a member signed came back changed');

    // and a stranger can read whose it is, and what it names, without asking
    const back = decodeCheckpointReceipt(splitSignedReceipt(body).body);
    assert.deepEqual(back.nodePubkey, schnorr.getPublicKey(member));
    assert.deepEqual(back.checkpointId, checkpointId(elsewhere));
  } finally { await node.close(); await empty.close(); }
});

/**
 * THE THIRD DOOR THAT THREW THE RECORD AWAY.
 *
 * A mark at tick 30 naming the mark at 60 as its parent passes the head check
 * and dies on the monotonic-tick rule. It used to die unkept - and if the
 * player then sends an honest child of that same parent, those two marks name
 * one parent and are a fork by 13B's own rule, with the earlier record already
 * gone. Two doors had been fixed and this one had not, which is the same shape
 * of hole three times over.
 */
test('a mark refused for a backwards tick is kept, and pairs as a fork later', async () => {
  const { round, rid, eid, mark } = played();
  const parent = checkpointId(mark);

  // the player signs a state at tick 30 that claims to follow tick 60
  const backwards = { ...mark, tick: 30, stateHash: b32(0xb0), previousHash: parent };
  assert.throws(() => round.checkpoint(signedBy(backwards)),
    /expected a tick after 60, got 30/);
  assert.equal(round.offeredMarks(rid, eid).length, 1, 'the record was thrown away');

  // nothing of ours contradicts it yet, so nothing is published
  assert.deepEqual(round.equivocation(rid, eid), []);

  // and then an honest child of the same parent arrives
  const honest = { ...mark, tick: 120, stateHash: b32(0xa1), previousHash: parent };
  round.checkpoint(signedBy(honest));

  const held = round.equivocation(rid, eid);
  assert.equal(held.length, 1, 'two children of one parent were not paired');
  assert.equal(held[0].how, 'two chains from one parent');

  const node = await serve(round.db, { port: 0, funded: () => true });
  try {
    const base = `http://127.0.0.1:${node.port}`;
    const r = await fetch(`${base}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(r.status, 200);
    const body = new Uint8Array(await r.arrayBuffer());
    const e = decodeEntryContract(new Uint8Array(
      await (await fetch(`${base}/entry?id=${toHex(eid)}`)).arrayBuffer()));
    const seen = await provesEquivocation(
      body.subarray(0, SIGNED_CHECKPOINT_BYTES),
      body.subarray(SIGNED_CHECKPOINT_BYTES), e.sessionPubkey, verify);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.how, 'two chains from one parent');
  } finally { await node.close(); }
});

/** A repeat of the mark already stored is still not evidence of anything. */
test('re-sending the stored mark keeps nothing and publishes nothing', () => {
  const { round, rid, eid, mark } = played();
  round.checkpoint(signedBy(mark));            // the same bytes again
  assert.equal(round.offeredMarks(rid, eid).length, 0);
  assert.deepEqual(round.equivocation(rid, eid), []);
});
