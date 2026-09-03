// The two doors, end to end: a round is opened over HTTP, a player joins,
// sends batches over the socket, and the round is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
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
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});

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
