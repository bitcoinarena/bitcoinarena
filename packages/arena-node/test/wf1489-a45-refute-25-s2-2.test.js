// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// REFUTE #1862/#2267 (wf1489 audit45 item 25), skeptic 2, variant 2: THE PUBLIC LATE FIRST MARK REPLAYED WHILE ONE PEER
// IS DOWN.
//
// #2267 skips the forward of a replayed decided late start only once EVERY peer answered the forward that went with it.
// While one peer of the round is down (unanswered), every stranger frame of the public mark (GET /start-forfeit) makes
// the seat POST /first-mark to EVERY peer again - the live ones included: one free frame, one request per peer, forever.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { assert, joinAndBuild, say, signerNodes, toHex, wait } from './first-mark-fixture.js';

const fromHexLocal = (h) => Uint8Array.from(Buffer.from(String(h), 'hex'));

const spyServer = () => new Promise((resolve) => {
  const hits = { firstMark: 0, entryVoid: 0, paths: [] };
  const srv = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    hits.paths.push(path);
    if (path === '/first-mark') hits.firstMark++;
    if (path === '/entry-void') hits.entryVoid++;
    req.resume();
    req.on('end', () => { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ forfeit: true, why: 'FORFEIT: late' })); });
  });
  srv.listen(0, '127.0.0.1', () => resolve({ hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
});

test('a stranger replaying the public late first mark while one peer is down makes the seat forward to no peer per frame', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);
    const bUrl = `http://127.0.0.1:${w.b.port}`;
    await w.downB();                                              // B is down: the late start's forward to it is unanswered
    for (const m of run.late) await say(w.a.port, m);
    for (let i = 0; i < 40 && !(await (await fetch(`http://127.0.0.1:${w.a.port}/start-forfeit?entry=${toHex(run.eid)}`)).json().catch(() => ({}))).forwarded; i++) await wait(100);
    assert.ok(w.a.round.startForfeit(run.eid), 'A recorded no late start');
    const r = await fetch(`http://127.0.0.1:${w.a.port}/start-forfeit?entry=${toHex(run.eid)}`);
    const got = await r.json();
    console.log('  FORWARDED:', JSON.stringify(got.forwarded));
    const mark = fromHexLocal(got.mark);
    w.a.verifier.peers = [bUrl, spy.url];                         // B still down; the spy is a live peer
    const N = 5;
    for (let i = 0; i < N; i++) await say(w.a.port, mark);
    for (let i = 0; i < 40 && spy.hits.firstMark < N; i++) await wait(100);
    console.log('  FACTS:', JSON.stringify({ firstMarkHits: spy.hits.firstMark, entryVoidHits: spy.hits.entryVoid }));
    assert.ok(spy.hits.firstMark <= 1,
      `${N} stranger replays of the public late first mark made A POST /first-mark to a live peer ${spy.hits.firstMark} times while one peer is down`);
  } finally {
    await spy.close();
    await w.close();
  }
});
