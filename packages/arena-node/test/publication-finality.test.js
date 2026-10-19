// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { testNow, skipTo } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { resultFinality } from '../src/finality.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { CLOCK } from './block-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { transcriptBytesHash } from '../../arena-protocol/src/posting.js';
import {
  b32, rand, WINDOW_MS, wait, WINNER, LOSER, contractFor, say, joinAndPlay, opts, sevenSignerNodes,
} from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';

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

const mayRelease = (w, name) => w.holder.stakeSecrets.mayRelease(w.rid, w.runs[name].eid);

// AFTER THE WINDOW AN UNPUBLISHED RUN IS VOID (§13A "a settlement seat that cannot retrieve the transcript within the
// result window treats the entry as VOID"RULED 2026-10-04). Before, a round dated in 1970 read "0 of
// 5 have posted" past its window for good - and postings arriving then could still make it FINAL.
test('seven signer nodes, five sign and nobody posts the transcript anywhere: after the window the run is VOID, and says why', async () => {
  const relay = await countingRelay();
  const w = await sevenSignerNodes(1000, [relay.url], { endMs: testNow() + 4000 });
  try {
    w.sign('agrees', () => ({}), { posted: false });
    skipTo(Number(windowsOf(w.contract).finalAfterMs) + 100);
    await wait(1200);
    const may = mayRelease(w, 'agrees');
    const f = resultFinality(w.holder.round, w.rid, w.runs.agrees.eid);
    const facts = { final: may.ok, state: f.state, relayAsked: relay.seen.length, relayHolds: relay.held.size };
    console.log('  FACTS (7 signer nodes, nothing posted):', JSON.stringify(facts), f.why || '');
    assert.deepEqual(facts, { final: false, state: 'VOID', relayAsked: 0, relayHolds: 0 });
    assert.match(f.why, /: 0 of 5 postings held in time - a seat that cannot retrieve the transcript within the result window treats the entry as VOID/);
  } finally { await w.close(); await relay.close(); }
});

// THE WINDOW RUNS FROM THE ROUND'S END, AND THE POSTING IS A CONDITION OF SIGNING FINAL (§13A, WINDOW-10-SPEC, RULED the owner
// 2026-10-01). Inside the window four postings are not publication and no seat signs FINAL; the fifth, held in time, and
// past the window a seat may - and five signatures make it FINAL (postings count only if held in time).
test('seven signer nodes: four postings are not enough; with the fifth a seat signs FINAL - the window itself runs from the round\'s end', async () => {
  const w = await sevenSignerNodes(1000, undefined, { endMs: testNow() + 4000 });
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    const eid = w.runs.agrees.eid;
    const four = mayRelease(w, 'agrees');
    assert.equal(four.ok, false, 'four postings made the run final');
    const fourAt = resultFinality(w.holder.round, w.rid, eid);
    assert.deepEqual([fourAt.published, fourAt.posted], [false, 4], fourAt.why);
    const asked = await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
    assert.equal(asked.status, 409, 'the holder signed FINAL on a transcript four seats posted');

    w.post('agrees', 5);                    // the fifth signer node's posting, inside the window
    skipTo(Number(windowsOf(w.contract).finalAfterMs) + 100);
    const five = resultFinality(w.holder.round, w.rid, eid);
    assert.ok(five.signable, `five postings, and still not signable: ${five.why}`);
    assert.equal(five.provisionalAtMs, Number(roundEndMs(w.contract)), 'the window does not run from the round\'s end');
    const signed = await w.finalNow('agrees');
    assert.equal(signed.state, 'FINAL', signed.why);
    const after = mayRelease(w, 'agrees');
    assert.equal(after.ok, true, `the run was not final once five seats signed it after its fifth posting: ${after.why}`);
  } finally { await w.close(); }
});

test('seven signer nodes: postings from keys that are not assigned, or about another transcript, count for nothing', async () => {
  const w = await sevenSignerNodes(500, undefined, { endMs: testNow() + 4000 });
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    w.post('agrees', 3, {}, [rand(32), rand(32), rand(32)]);           // three strangers
    w.post('agrees', 6, { transcriptHash: b32(0x77) });                // the fifth and sixth signer node, about another transcript
    await wait(700);
    const may = mayRelease(w, 'agrees');
    assert.equal(may.ok, false, 'strangers or postings of another transcript made the run final');
    const f = resultFinality(w.holder.round, w.rid, w.runs.agrees.eid);
    assert.deepEqual([f.published, f.posted], [false, 4], f.why);
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
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
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
