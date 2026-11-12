// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// AN UNVERIFIED FIRST MARK MUST NOT MAKE A SEAT QUERY ITS PEERS (wf1489 r8, attacker).
//
// The /play socket's per-frame pipeline (server.js) decides, for a first mark
// this seat does not hold, whether the entry is late/ENTRY_VOID. When its OWN
// store carries nothing (lateEvidenceHere === null, which is the case for a live
// entry whose real first mark has not yet landed), it calls lateByPeers(), which
// fetches GET /entry-void?entry=<eid> from EVERY peer of the round.
//
// That peer fan-out happens BEFORE the mark's signature is ever checked: the
// signature is verified only further down, in handle() -> round.checkpoint().
// firstMarkOf() only decodes the frame; it does not verify it.
//
// So a stranger (role d: knows a public round id and a public entry id from the
// explorer) can send a FORGED first-mark frame - a well-formed checkpoint with a
// garbage signature, previousHash all zeros, any tick within the start line - and
// the seat answers it by hammering all its peers with /entry-void. One cheap
// inbound frame -> one outbound request per peer, with no signature, no stake, no
// authority of any kind required. A flood of such frames is a peer-amplification
// DoS the attacker drives for free.
//
// SAFE BEHAVIOUR: a first mark whose signature does not verify under the entry's
// session key is refused without any peer being queried. This test sets the
// seat's only peer to a spy that counts /entry-void requests and asserts the spy
// is never touched. On 85f803d70 the spy IS touched -> the test FAILS on HEAD.
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  assert, checkpointId, encodeCheckpoint, joinAndBuild, joinSigned, NO_PREVIOUS, rand, say, signerNodes, toHex, wait,
} from './first-mark-fixture.js';

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

test('a first mark with a garbage signature makes the seat query no peer (wf1489 r8)', async () => {
  const w = await signerNodes();
  const spy = await spyServer();
  try {
    const run = await joinAndBuild(w);                 // a real, live, paid entry at seat A (and B)
    // The seat's only peer is the spy, which counts every /entry-void it is asked.
    w.a.verifier.peers = [spy.url];

    // A STRANGER'S FORGED FIRST MARK for that public entry: a well-formed
    // checkpoint (previousHash all zero -> a first mark, tick 5 -> inside the
    // 900-tick start line) carrying a random, invalid signature.
    const forged = {
      roundId: w.rid, entryId: run.eid, tick: 5,
      stateHash: rand(32), inputChainHash: rand(32), previousHash: NO_PREVIOUS,
    };
    const frame = joinSigned(encodeCheckpoint(forged), rand(64));   // 64 random bytes = not the player's signature
    // sanity: this is not a mark the seat already holds
    assert.equal(w.a.round.holdsMark(checkpointId(forged)), false);

    const answer = await say(w.a.port, frame);
    // give any fan-out time to reach the spy
    for (let i = 0; i < 20 && spy.hits.entryVoid === 0; i++) await wait(50);

    console.log('  FACTS:', JSON.stringify({ answer: String(answer).slice(0, 60), entryVoidHits: spy.hits.entryVoid, paths: spy.hits.paths }));
    // SAFE: an unverified first mark queries no peer.
    assert.equal(spy.hits.entryVoid, 0,
      'a forged (unsigned) first mark made the seat fetch /entry-void from a peer - unverified input drives peer fan-out (wf1489 r8)');
  } finally {
    await spy.close();
    await w.close();
  }
});
