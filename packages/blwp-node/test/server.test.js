// The two doors, end to end: a round is opened over HTTP, a player joins,
// sends batches over the socket, and the round is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS,
  joinSigned, splitSigned, SIGNED_CHECKPOINT_BYTES, CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GENESIS, decodeTranscript, checkTranscript, transcriptHash } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});

/** What a client puts on the wire: the encoding, then the signature over its id. */
const sign = (c, key = session) =>
  joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), key));

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
};

const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const said = [];
  sock.addEventListener('message', (e) => {
    const v = said.shift();
    if (v) v(typeof e.data === 'string' ? e.data : e.data);
  });
  sock.addEventListener('open', () => resolve({
    say: (m) => new Promise((r) => { said.push(r); sock.send(m); }),
    shut: () => sock.close(),
  }));
});

test('a round is opened, joined, played and closed by one process', async () => {
  const node = await serve(openStore(), { port: 0 });
  try {
    const c = contract();
    const opened = await post(node.port, '/round', encodeRoundContract(c));
    assert.equal(opened.status, 201);
    assert.equal(toHex(opened.bytes), toHex(roundId(c)),
      'the node answers with the id the protocol computes, not one of its own');

    const got = await fetch(`http://127.0.0.1:${node.port}/round?id=${toHex(opened.bytes)}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-state'), '0');
    assert.equal(toHex(new Uint8Array(await got.arrayBuffer())), toHex(encodeRoundContract(c)),
      'and gives back the contract byte for byte');

    const e = entryFor(opened.bytes);
    const joined = await post(node.port, '/entry', encodeEntryContract(e));
    assert.equal(joined.status, 201);
    assert.equal(toHex(joined.bytes), toHex(entryId(e)));

    const sock = await talk(node.port);
    let prev = GENESIS;
    const batch = (first, n, chainTo = prev) => {
      const b = {
        roundId: opened.bytes, entryId: joined.bytes, previousHash: chainTo, firstTick: first,
        ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]),
        liquidations: first === 0 ? [[1, 3 * 65536]] : [],
      };
      return { bytes: encodeInputBatch(b), id: batchId(b) };
    };

    const one = batch(0, 60);
    assert.equal(await sock.say(one.bytes), '60', 'sixty new ticks');
    assert.equal(await sock.say(one.bytes), '0', 'the same message again is a no-op');
    prev = one.id;
    const two = batch(60, 60);
    assert.equal(await sock.say(two.bytes), '60');
    prev = two.id;

    assert.equal(await sock.say('close ' + toHex(opened.bytes)), 'closed');
    assert.equal(await sock.say('close ' + toHex(opened.bytes)), 'already closed');
    assert.match(await sock.say(batch(120, 10).bytes), /closed/, 'and it takes nothing after that');
    sock.shut();

    // The transcript as ONE object, fetched the way a second node would.
    const got2 = await fetch(
      `http://127.0.0.1:${node.port}/transcript?round=${toHex(opened.bytes)}&entry=${toHex(joined.bytes)}`);
    assert.equal(got2.status, 200);
    assert.equal(got2.headers.get('x-ticks'), '120');
    const t2 = decodeTranscript(new Uint8Array(await got2.arrayBuffer()));
    assert.deepEqual(checkTranscript(t2), { ok: true, ticks: 120 });
    assert.equal(got2.headers.get('x-transcript-hash'), toHex(transcriptHash(t2)),
      'the hash the node states is the hash of what it sent');

    const t = node.round.transcript(opened.bytes, joined.bytes);
    assert.equal(t.ticks.length, 120, 'the transcript is the round');
    assert.deepEqual(t.ticks.map((x) => x.tick).slice(0, 3), [0, 1, 2]);
    assert.deepEqual(t.liquidations, [[1, 3 * 65536]], 'and carries the strike exactly once');
    assert.deepEqual(node.round.gaps(opened.bytes, joined.bytes), []);
  } finally { await node.close(); }
});

test('an entry for a round the node has not got is refused with a reason', async () => {
  const node = await serve(openStore(), { port: 0 });
  try {
    const r = await fetch(`http://127.0.0.1:${node.port}/entry`,
      { method: 'POST', body: encodeEntryContract(entryFor(b32(99))) });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /no such round/);
  } finally { await node.close(); }
});

test('checkpoints cross the wire, and the refusals cross it too', async () => {
  // THE SEAM. `Round.checkpoint` was covered and the wire was not: the type
  // dispatch on /play and the GET both went untested, which is exactly where
  // an object that works can still fail to arrive.
  const node = await serve(openStore(), { port: 0 });
  try {
    const c = contract();
    const rid = (await post(node.port, '/round', encodeRoundContract(c))).bytes;
    const e = entryFor(rid);
    const eid = (await post(node.port, '/entry', encodeEntryContract(e))).bytes;

    const sock = await talk(node.port);

    // real inputs first, because a mark names the batch that produced it
    const b = {
      roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 200 }, (_, i) => [65536, i, 0, 0, 0]),
      liquidations: [],
    };
    assert.equal(await sock.say(encodeInputBatch(b)), '200', 'the batch landed');
    const inputs = batchId(b);

    const mark = (tick, state, previousHash) => ({
      roundId: rid, entryId: eid, tick,
      stateHash: b32(state), inputChainHash: inputs, previousHash,
    });

    // ONE SOCKET, TWO KINDS: the first byte is the protocol's type, so a
    // checkpoint needs no second connection and no envelope.
    const first = mark(60, 0x5a, NO_PREVIOUS);
    assert.equal(await sock.say(sign(first)), 'stored');
    assert.equal(await sock.say(sign(first)), 'repeat');

    const second = mark(120, 0x5b, checkpointId(first));
    assert.equal(await sock.say(sign(second)), 'stored');

    // equivocation, over the wire
    const twin = mark(120, 0x5c, checkpointId(first));
    const refused = await sock.say(sign(twin));
    assert.match(refused, /^error equivocation at tick 120/);
    assert.ok(refused.includes(toHex(checkpointId(second))), 'the stored id crosses the wire too');

    // and the backwards tick
    const backwards = mark(90, 0x5d, checkpointId(second));
    assert.match(await sock.say(sign(backwards)),
      /^error expected a tick after 120, got 90/);

    // and inputs the node never saw
    const invented = { ...mark(180, 0x5e, checkpointId(second)), inputChainHash: b32(0xee) };
    assert.match(await sock.say(sign(invented)),
      /names inputs this node has not seen/);

    // AND THE SIGNATURE, on the same seam. An unsigned mark has no shorter
    // form to send, a stranger's key does not verify, and a body changed
    // after signing does not either.
    const third = mark(180, 0x5f, checkpointId(second));
    assert.match(await sock.say(encodeCheckpoint(third)),
      new RegExp(`a signed checkpoint is ${SIGNED_CHECKPOINT_BYTES} bytes, got ${CHECKPOINT_BYTES}`));

    const stranger = ed25519.utils.randomSecretKey();
    assert.match(await sock.say(sign(third, stranger)),
      /does not verify under the entry's session key/);

    const tampered = joinSigned(
      encodeCheckpoint({ ...third, stateHash: b32(0x60) }),
      sign(third).slice(CHECKPOINT_BYTES));
    assert.match(await sock.say(tampered),
      /does not verify under the entry's session key/);

    sock.shut();

    // GET /checkpoints: the two that were accepted, in tick order, as
    // fixed-size records back to back.
    const got = await fetch(
      `http://127.0.0.1:${node.port}/checkpoints?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-checkpoints'), '2',
      'only the two that were accepted - none of the six refusals stored a byte');
    const body = new Uint8Array(await got.arrayBuffer());
    assert.equal(body.length, 2 * SIGNED_CHECKPOINT_BYTES,
      'the wrapper crosses the read as well: 231 bytes a mark');
    const size = SIGNED_CHECKPOINT_BYTES;
    const marks = [splitSigned(body.slice(0, size)), splitSigned(body.slice(size))];
    assert.deepEqual(marks.map((m) => decodeCheckpoint(m.body).tick), [60, 120]);
    assert.equal(toHex(decodeCheckpoint(marks[0].body).stateHash), toHex(b32(0x5a)),
      'the bytes that come back are the bytes that went in');
    assert.ok(ed25519.verify(marks[0].signature, checkpointId(first), sessionPubkey),
      'and the signature that comes back still verifies');
  } finally {
    await node.close();
  }
});
