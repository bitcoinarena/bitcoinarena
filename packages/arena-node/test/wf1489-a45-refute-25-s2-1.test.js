// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// REFUTE #1862/#2267 (wf1489 audit45 item 25), skeptic 2, variant 1: THE PLAYER'S ON-TIME FIRST MARK, PUBLIC AT
// GET /checkpoints, REPLAYED BY A STRANGER AT A SEAT THAT DOES NOT HOLD IT.
//
// #2267 skips lateByPeers only for a mark PAST the start line. An on-time first mark verifies, is inside the line
// (peersCanTell), and at a seat that was down while the player started it is not held. Sent alone (without the batch it
// commits to) it is refused by the chain's inputs rule - so it is never held - and every replayed frame makes the seat
// fetch /entry-void from every peer, each awaited in the socket's queue: one free frame, one request per peer (#1862).
import { test } from 'node:test';
import { createServer } from 'node:http';
import { assert, joinAndBuild, say, signerNodes, toHex, wait } from './first-mark-fixture.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';

const spyServer = () => new Promise((resolve) => {
  const hits = { entryVoid: 0, paths: [] };
  const srv = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    hits.paths.push(path);
    if (path === '/entry-void') hits.entryVoid++;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('this spy holds no such entry');
  });
  srv.listen(0, '127.0.0.1', () => resolve({ hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
});

test('a stranger replaying the public ON-TIME first mark at a seat that lacks it makes the seat query no peer per frame', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);
    await w.downB();                                              // B is down while the player starts at A
    await say(w.a.port, run.messages[0]);
    await say(w.a.port, run.messages[1]);                         // the on-time first mark (tick 60), taken at A
    await wait(300);
    assert.ok(w.a.round.holdsMark(run.firstId), 'A did not take the on-time first mark');
    await w.upB();
    assert.ok(!w.b.round.holdsMark(run.firstId), 'B already holds the first mark');
    // THE STRANGER reads the mark off A's public door
    const r = await fetch(`http://127.0.0.1:${w.a.port}/checkpoints?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    assert.equal(r.status, 200);
    const mark = new Uint8Array(await r.arrayBuffer()).subarray(0, SIGNED_CHECKPOINT_BYTES);
    assert.equal(toHex(mark), toHex(run.messages[1]));
    w.b.verifier.peers = [spy.url];                               // count only what the stranger's frames cause
    const N = 5;
    const answers = [];
    for (let i = 0; i < N; i++) answers.push(String(await say(w.b.port, mark)).slice(0, 90));
    await wait(300);
    console.log('  FACTS:', JSON.stringify({ answers, entryVoidHits: spy.hits.entryVoid, held: w.b.round.holdsMark(run.firstId), paths: spy.hits.paths }));
    assert.ok(spy.hits.entryVoid <= 1,
      `${N} replays of a public on-time first mark made seat B fetch /entry-void ${spy.hits.entryVoid} times - a stranger's frame still drives peer fan-out (#1862)`);
  } finally {
    await spy.close();
    await w.close();
  }
});
