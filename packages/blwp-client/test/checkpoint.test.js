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

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import {
  decodeCheckpoint, checkpointId, splitSigned, NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';
import { Client, markState } from '../src/client.js';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const sign = (id) => ed25519.sign(id, session);

const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
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

async function rig() {
  const node = await serve(openStore(), { port: 0 });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign });
  const c = contract();
  const rid = await client.openRound(c);
  assert.deepEqual(rid, roundId(c), 'the node named a different round than the contract hashes to');
  const e = entryFor(rid);
  const eid = await client.join(e);
  assert.deepEqual(eid, entryId(e), 'the node named a different entry than the contract hashes to');
  await client.connect();
  return { node, client, rid, eid };
}

test('the client sends a state hash and the node stores it at that tick', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    const st = driven(120);
    const own = core.hash(st);
    assert.equal(own.length, 64, 'a state hash is 32 bytes of hex');
    assert.notEqual(own, core.hash(core.init(7)), 'a driven core must not hash like a fresh one');

    const sent = await client.checkpoint(st, { roundId: rid, entryId: eid, tick: 120 });
    assert.equal(sent.answer, 'stored', `the node refused the mark: ${sent.answer}`);

    // AND THE NODE IS HOLDING WHAT THE CLIENT COMPUTED, not merely something.
    const got = await marks(node.port, rid, eid);
    assert.equal(got.count, 1);
    assert.equal(got.bytes.length, SIGNED_CHECKPOINT_BYTES);

    const { body, signature } = splitSigned(got.bytes);
    const stored = decodeCheckpoint(body);
    assert.deepEqual(checkpointId(stored), sent.id, 'the stored id is not the one the client signed');
    assert.equal(stored.tick, 120);
    assert.deepEqual(stored.previousHash, NO_PREVIOUS, 'the first mark of a round chains to nothing');
    assert.deepEqual(stored.inputChainHash, GENESIS, 'no batch was sent, so it names the genesis');
    assert.equal(toHex(stored.stateHash), own,
      'the hash on the wire is not the hash the core produced');
    assert.ok(ed25519.verify(signature, sent.id, sessionPubkey),
      'the stored signature does not verify under the session key in the entry contract');
  } finally { client.close(); await node.close(); }
});

test('a second, different hash at the same tick is refused as equivocation', async () => {
  const { node, client, rid, eid } = await rig();
  try {
    const first = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(first.answer, 'stored');

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
    assert.equal((await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 })).answer,
                 'stored');

    // The head has moved on; this one still chains to the start of the round.
    const orphan = markState(core, driven(120),
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
    const stored = await client.checkpoint(driven(60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(stored.answer, 'stored');

    const backwards = await client.checkpoint(driven(30), { roundId: rid, entryId: eid, tick: 30 });
    assert.equal(backwards.answer, 'error expected a tick after 60, got 30');
    assert.equal((await marks(node.port, rid, eid)).count, 1, 'the refused mark must not be stored');

    const next = await client.checkpoint(driven(120), { roundId: rid, entryId: eid, tick: 120 });
    assert.equal(next.answer, 'stored',
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
    const client = new Client({ base: `http://127.0.0.1:${port}`, core, sign });
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
