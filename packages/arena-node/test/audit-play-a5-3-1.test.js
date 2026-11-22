// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// AUDIT play r3-1 (gap in #2750 / #2387): the /play replay test (replayOfHeld) compares the frame's BYTES with the stored first
// mark, but a first mark's signature is over checkpointId, which re-encodes the fields with PROTOCOL_VERSION. A copy of the public
// first mark with another speaksVersion() version byte (25 accepted) still verifies (signedFirst), is no "replay of the held mark",
// and so runs forwardFirstMark with no reofferDue clock: every peer that has not receipted gets POST /first-mark per frame.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { assert, joinAndBuild, say, signerNodes, toHex, wait } from './first-mark-fixture.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';

const spyServer = () => new Promise((resolve) => {
  const hits = { firstMark: 0 };
  const srv = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/first-mark') hits.firstMark++;
    req.resume();
    req.on('end', () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ why: 'busy' })); });
  });
  srv.listen(0, '127.0.0.1', () => resolve({ hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
});

test('a version-byte copy of the held public first mark, replayed on /play, is forwarded to no peer per frame', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);
    const bUrl = `http://127.0.0.1:${w.b.port}`;
    await w.downB();
    await say(w.a.port, run.messages[0]);
    await say(w.a.port, run.messages[1]);                         // the on-time first mark, taken at A
    await wait(500);
    assert.ok(w.a.round.holdsMark(run.firstId), 'A did not take the on-time first mark');
    const r = await fetch(`http://127.0.0.1:${w.a.port}/checkpoints?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    assert.equal(r.status, 200);
    const mark = new Uint8Array(await r.arrayBuffer()).subarray(0, SIGNED_CHECKPOINT_BYTES);
    w.a.verifier.peers = [bUrl, spy.url];
    // control: byte-identical replays are throttled by the #2750 fix
    for (let i = 0; i < 3; i++) await say(w.a.port, mark);
    for (let i = 0; i < 20; i++) await wait(100);
    const afterPlain = spy.hits.firstMark;
    // the attack: the same mark with version byte 2 (any of SUPPORTED_PROTOCOL_VERSIONS), same signature
    const copy = new Uint8Array(mark);
    copy[1] = 0; copy[2] = 2;
    const N = 10;
    const answers = [];
    for (let i = 0; i < N; i++) answers.push(String(await say(w.a.port, copy)).slice(0, 60));
    for (let i = 0; i < 30 && spy.hits.firstMark - afterPlain < N; i++) await wait(100);
    const viaCopy = spy.hits.firstMark - afterPlain;
    console.log('  FACTS:', JSON.stringify({ afterPlain, viaCopy, answers: answers.slice(0, 2) }));
    assert.ok(viaCopy <= 1,
      `${N} replays of a version-byte copy of the held first mark made A POST /first-mark to a peer ${viaCopy} times (plain replays: ${afterPlain})`);
  } finally {
    await spy.close();
    await w.close();
  }
});
