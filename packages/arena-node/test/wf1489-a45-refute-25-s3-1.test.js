// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// REFUTE #1862/#2267/#2353/#2357 (wf1489 audit45 item 25), skeptic 3, variant 1: THE PUBLIC ON-TIME FIRST MARK REPLAYED
// AT THE SEAT THAT HOLDS IT, while a peer has not receipted it.
//
// #2357 rate-limits the forward only for a replay of the DECIDED LATE START. A seat that HOLDS the player's on-time first
// mark (public at GET /checkpoints) runs forwardFirstMark on every signed first mark frame: every peer whose offer is not
// 'receipted' (one that was down, or refused it) is POSTed /first-mark again - per stranger frame, forever.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { assert, joinAndBuild, say, signerNodes, toHex, wait } from './first-mark-fixture.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';

const spyServer = () => new Promise((resolve) => {
  const hits = { firstMark: 0, entryVoid: 0, paths: [] };
  const srv = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    hits.paths.push(path);
    if (path === '/first-mark') hits.firstMark++;
    if (path === '/entry-void') hits.entryVoid++;
    req.resume();
    req.on('end', () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ why: 'busy' })); });
  });
  srv.listen(0, '127.0.0.1', () => resolve({ hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
});

test('a stranger replaying the public on-time first mark at the seat that holds it makes it forward to no peer per frame', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);
    const bUrl = `http://127.0.0.1:${w.b.port}`;
    await w.downB();                                              // B is down while the player starts at A
    await say(w.a.port, run.messages[0]);
    await say(w.a.port, run.messages[1]);                         // the on-time first mark, taken at A
    await wait(500);
    assert.ok(w.a.round.holdsMark(run.firstId), 'A did not take the on-time first mark');
    const r = await fetch(`http://127.0.0.1:${w.a.port}/checkpoints?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    assert.equal(r.status, 200);
    const mark = new Uint8Array(await r.arrayBuffer()).subarray(0, SIGNED_CHECKPOINT_BYTES);
    assert.equal(toHex(mark), toHex(run.messages[1]));
    w.a.verifier.peers = [bUrl, spy.url];                         // B still down; the spy is a live peer that has not receipted
    const N = 5;
    const answers = [];
    for (let i = 0; i < N; i++) answers.push(String(await say(w.a.port, mark)).slice(0, 80));
    for (let i = 0; i < 30 && spy.hits.firstMark < N; i++) await wait(100);
    console.log('  FACTS:', JSON.stringify({ answers, firstMarkHits: spy.hits.firstMark, entryVoidHits: spy.hits.entryVoid }));
    assert.ok(spy.hits.firstMark <= 1,
      `${N} stranger replays of the public on-time first mark made A POST /first-mark to a peer ${spy.hits.firstMark} times`);
  } finally {
    await spy.close();
    await w.close();
  }
});
