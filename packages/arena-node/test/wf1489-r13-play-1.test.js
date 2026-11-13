// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 13 (play path): ONE SEAT'S GET /receipts ANSWER KEEPS EVERY HONEST SEAT FROM SIGNING A WALK-AWAY FORFEIT.
// verify.js #neverStarted signs FORFEIT 0 over the empty transcript (§15, the door sweep ALL-BUT-MIN-1727) only when the
// close's receipt pull found `refused.length === 0 && taken === 0`. A receipt carries only (checkpoint id, node key): nothing
// binds it to the entry asked about. So one seat that adds a single receipt it signed over a made-up checkpoint id to its
// /receipts answer ("a receipt for a mark this node has not got") makes every honest seat read "may have started" and sign
// nothing - for any paying entry whose player walked away. The stake is never decided; it goes back to the player at expiry.
// Safe: a receipt that is not shown to be of THIS entry's mark (signed by its session key) is no doubt; the door signs FORFEIT.
import { test } from 'node:test';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { assert, signerNodes, joinAndBuild } from './first-mark-fixture.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { encodeCheckpointReceipt, joinSignedReceipt, receiptId } from '../../arena-protocol/src/receipt.js';
import { wait } from './window-fixture.js';

test('#1489-r13-play-1: one seat\'s receipt over a made-up mark does not stop the honest seat\'s walk-away FORFEIT', async () => {
  const w = await signerNodes({ serveOpts: { doorSweepMs: 250 } });
  // SEAT B AS A's PEER, through a proxy that adds one receipt B signed over 32 random bytes to every /receipts answer
  const bBase = () => `http://127.0.0.1:${w.b.port}`;
  const evil = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await fetch(bBase() + req.url, { method: req.method, body: chunks.length ? Buffer.concat(chunks) : undefined });
      let body = Buffer.from(await r.arrayBuffer());
      let status = r.status;
      if (req.url.startsWith('/receipts')) {
        const rec = { checkpointId: new Uint8Array(randomBytes(32)), receivedAtMs: BigInt(Date.now()), nodePubkey: w.b.round.pubkey };
        const one = joinSignedReceipt(encodeCheckpointReceipt(rec), schnorr.sign(receiptId(rec), w.b.round.identity.secret));
        body = Buffer.concat([status === 200 ? body : Buffer.alloc(0), Buffer.from(one)]);
        status = 200;
      }
      res.writeHead(status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(502); res.end(String(e.message)); }
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  try {
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`];
    const run = await joinAndBuild(w);                // joined and locked at both, the stake seen; no mark is ever sent
    assert.ok(w.a.round.stakeSeen(run.eid), 'the stake is committed at seat A');
    const results = (d) => d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
    let signed = null;
    for (const stop = Date.now() + 45000; Date.now() < stop; await wait(250)) {
      if (results(w.a).length) { signed = results(w.a)[0]; break; }
    }
    const carried = w.a.verifier.carried.get(`${Buffer.from(w.rid).toString('hex')}:${Buffer.from(run.eid).toString('hex')}`);
    console.log('  FACTS:', JSON.stringify({ aSigned: signed && [signed.outcome, signed.score], bSigned: results(w.b).map((x) => x.outcome),
      carried: carried && { taken: carried.taken, refused: carried.refused, down: carried.down } }));
    assert.ok(signed, 'one seat\'s receipt over a made-up mark kept seat A from signing the walk-away at the door for 45 s');
    assert.deepEqual([signed.outcome, signed.score], ['FORFEIT', 0]);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
