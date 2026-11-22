// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (play path): ONE PEER'S JUNK GET /receipts ANSWER MUST NOT SAVE A WALK-AWAY FROM FORFEIT.
// A seated, staked player who sends no first mark is FORFEIT 0 at the door (§15, ALL-BUT-MIN-1727). The door's
// decision (verifier.retryClose -> #neverStarted) requires carried.refused.length === 0: ANY receipt a peer sends that
// takeReceipt refuses (here 144 zero bytes - not a receipt at all) stops the FORFEIT at every honest seat, for every
// walk-away of the round. Safe: a peer's bytes that are not a valid receipt of a mark are no evidence the player started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

test('#1489-r2-play-1: one peer answering GET /receipts with junk does not keep an honest seat from signing a walk-away FORFEIT at the door', async () => {
  // THE ONE BAD PEER: 200 and one receipt-sized block of zero bytes at /receipts, 404 for everything else
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/receipts')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(SIGNED_RECEIPT_BYTES)); }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500 } });
  try {
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    const results = (d) => d.round.results(w.rid, walker.eid).length;
    for (const stop = Date.now() + 30000; Date.now() < stop && !(results(w.a) && results(w.b)); await wait(250));
    const facts = { atA: results(w.a), atB: results(w.b), carriedAtA: w.a.verifier.carried.get(`${Buffer.from(w.rid).toString('hex')}:${Buffer.from(walker.eid).toString('hex')}`) };
    console.log('  FACTS:', JSON.stringify({ atA: facts.atA, atB: facts.atB, refusedAtA: facts.carriedAtA && facts.carriedAtA.refused }));
    assert.equal(facts.atB, 1, 'the control seat (no junk peer) signed nothing');
    assert.equal(facts.atA, 1, 'one peer\'s junk /receipts answer kept the honest seat from signing the walk-away FORFEIT');
  } finally { await w.close(); evil.close(); }
});
