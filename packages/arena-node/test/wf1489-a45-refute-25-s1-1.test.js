// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// REFUTE #1862 (wf1489 audit45 item 25), variant 1: A PUBLIC, GENUINELY SIGNED LATE FIRST MARK, REPLAYED BY A STRANGER.
//
// #1862 gates the /play late/void branch (lateByPeers: GET /entry-void from every peer) on the first mark's signature.
// But a seat serves the player's own signed late first mark to anyone at GET /start-forfeit. Replayed on /play, that
// mark verifies, is not held (a late start is never taken into the chain), secondFirstMark skips it (a retry of a
// refused late start), and lateEvidenceHere returns null (tick past the line) - so lateByPeers runs again for EVERY
// replayed frame, although for a late tick it can never find anything (lateEvidenceHere null, the pair needs an on-time
// tick). One free frame from a stranger -> one request per peer: the effect #1862 was made to stop.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { assert, joinAndBuild, say, signerNodes, toHex, wait } from './first-mark-fixture.js';

const fromHexLocal = (h) => Uint8Array.from(Buffer.from(String(h), 'hex'));

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

test('a stranger replaying the public late first mark (GET /start-forfeit) makes the seat query no peer (#1862 variant)', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);
    for (const m of run.late) await say(w.a.port, m);            // the player's own late start, refused FORFEIT at A
    await wait(500);
    assert.ok(w.a.round.startForfeit(run.eid), 'A recorded no late start: not the case');
    // THE STRANGER reads the mark off the public door
    const r = await fetch(`http://127.0.0.1:${w.a.port}/start-forfeit?entry=${toHex(run.eid)}`);
    assert.equal(r.status, 200);
    const mark = fromHexLocal((await r.json()).mark);
    w.a.verifier.peers = [spy.url];                              // count only what the stranger's frames cause
    const N = 5;
    const answers = [];
    for (let i = 0; i < N; i++) answers.push(String(await say(w.a.port, mark)).slice(0, 70));
    for (let i = 0; i < 20 && spy.hits.entryVoid < N; i++) await wait(50);
    console.log('  FACTS:', JSON.stringify({ answers, entryVoidHits: spy.hits.entryVoid, paths: spy.hits.paths }));
    assert.equal(spy.hits.entryVoid, 0,
      `${N} replays of a public late first mark made the seat fetch /entry-void ${spy.hits.entryVoid} times - a stranger's frame still drives peer fan-out (#1862)`);
  } finally {
    await spy.close();
    await w.close();
  }
});
