// A RESULT IS NOT FINAL UNTIL ITS TRANSCRIPT IS POSTED WHERE ANYONE CAN REPLAY IT (P2).
//
// Spec v4.6.2 §13A, "Publication is a condition of finality": a
// PROVISIONALLY_FINAL result is not FINAL until the canonical transcript it
// names has been retrieved by the round's threshold of settlement signer nodes and
// posted by them to the contract's `publication_relays[]`, and the window W
// counts from that posting. Without it a quorum that plays for itself sends the
// honest signer nodes nothing, signs what it likes, and nobody ever holds an object to
// replay (the §35A row "self-dealing quorum never publishes its transcript").
//
// MEASURED BEFORE (TASKBOOK): seven signer nodes, five signatures and nothing posted
// anywhere - FINAL after the window; two daemons whose contract named a relay -
// loser settled, winner cancelled, payout queued, the relay asked 0 times.
import { resultFinality } from '../src/finality.js';
import { CLOCK } from './block-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { transcriptBytesHash } from '../../protocol/src/posting.js';
import {
  b32, rand, WINDOW_MS, wait, WINNER, LOSER, contractFor, say, joinAndPlay, opts, sevenSignerNodes,
} from './window-fixture.js';

/** A relay that keeps whatever it is given and writes down every request; `lies` gives back other bytes. */
async function countingRelay({ lies = false } = {}) {
  const seen = [];
  const held = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, path: req.url, bytes: body.length });
    if (req.method === 'PUT' || req.method === 'POST') { held.set(req.url, body); res.writeHead(201); return res.end(); }
    const kept = held.get(req.url);
    if (!kept) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    return res.end(lies ? Buffer.concat([kept, Buffer.from([0])]) : kept);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, held, close: () => new Promise((r) => server.close(r)) };
}

const mayRelease = (w, name) => w.holder.preimages.mayRelease(w.rid, w.runs[name].eid);

test('seven signer nodes, five sign and nobody posts the transcript anywhere: after the window the run is still not final, and says why', async () => {
  const relay = await countingRelay();
  const w = await sevenSignerNodes(1000, [relay.url]);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    await wait(1200);
    const may = mayRelease(w, 'agrees');
    const facts = { final: may.ok, relayAsked: relay.seen.length, relayHolds: relay.held.size };
    console.log('  FACTS (7 signer nodes, nothing posted):', JSON.stringify(facts), may.why || '');
    assert.deepEqual(facts, { final: false, relayAsked: 0, relayHolds: 0 });
    assert.match(may.why, /0 of 5 settlement signer nodes have posted/);
  } finally { await w.close(); await relay.close(); }
});

test('seven signer nodes: four postings are not enough; the fifth opens the window, and W counts from it, not from the signatures', async () => {
  const w = await sevenSignerNodes(1000);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    await wait(1200);                       // a whole window after the signatures
    const four = mayRelease(w, 'agrees');
    assert.equal(four.ok, false, 'four postings made the run final');
    assert.match(four.why, /4 of 5 settlement signer nodes have posted/);

    w.post('agrees', 5);                    // the fifth signer node's posting, naming the block of now
    // THE WINDOW IS BLOCKS (RULED 2026-09-24): it opens at the block the threshold's posting names and ends at the first
    // block at or after that plus W - read on the node's own clock stubbed at those blocks, not by waiting on the wall.
    const eid = w.runs.agrees.eid;
    const open = resultFinality(w.holder.round, w.rid, eid).provisionalAtMs;
    const signedAt = CLOCK.mtpOf(CLOCK.tipAt(Date.now() - 1200));
    const stubAt = (now) => new (w.holder.preimages.constructor)(Object.assign(Object.create(w.holder.round), { now: () => now }), {});
    assert.ok(open > signedAt, `the window opened at ${open}, not after the signatures' block ${signedAt}`);
    const inside = stubAt(CLOCK.endAt(open, 1000) - 1).mayRelease(w.rid, eid);
    assert.equal(inside.ok, false, 'the window was counted from the signatures, not from the posting');
    assert.match(inside.why, /objection window/);
    const after = stubAt(CLOCK.endAt(open, 1000)).mayRelease(w.rid, eid);
    assert.equal(after.ok, true, `the run was not final at its window's end block after its fifth posting: ${after.why}`);
  } finally { await w.close(); }
});

test('seven signer nodes: postings from keys that are not assigned, or about another transcript, count for nothing', async () => {
  const w = await sevenSignerNodes(500);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    w.post('agrees', 3, {}, [rand(32), rand(32), rand(32)]);           // three strangers
    w.post('agrees', 6, { transcriptHash: b32(0x77) });                // the fifth and sixth signer node, about another transcript
    await wait(700);
    const may = mayRelease(w, 'agrees');
    assert.equal(may.ok, false, 'strangers or postings of another transcript made the run final');
    assert.match(may.why, /4 of 5 settlement signer nodes have posted/);
  } finally { await w.close(); }
});

// A paying round naming no relay is refused where it would be opened now
// (signer-node-relay.test.js); one stored before that rule must still never go final.
test('seven signer nodes: a contract that names no relay is never final, whatever five postings say', async () => {
  const w = await sevenSignerNodes(500, [], { storedBeforeTheRule: true });
  try {
    w.sign('agrees', () => ({}));
    await wait(700);
    const may = mayRelease(w, 'agrees');
    assert.equal(may.ok, false, 'a round with nowhere to post its transcripts went final');
    assert.match(may.why, /names no publication relay/);
  } finally { await w.close(); }
});

test('a daemon\'s relay door keeps a transcript only under the hash its bytes have', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const bytes = rand(300);
    const name = toHex(transcriptBytesHash(bytes));
    const wrong = await fetch(`http://127.0.0.1:${d.port}/transcript/${'ab'.repeat(32)}`, { method: 'PUT', body: bytes });
    assert.equal(wrong.status, 409);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/transcript/${'ab'.repeat(32)}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/transcript/${name}`, { method: 'PUT', body: bytes })).status, 201);
    const back = new Uint8Array(await (await fetch(`http://127.0.0.1:${d.port}/transcript/${name}`)).arrayBuffer());
    assert.equal(toHex(back), toHex(bytes));
  } finally { await d.close(); }
});
