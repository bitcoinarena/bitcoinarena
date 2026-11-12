// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1-refute-55 skeptic 2 (#1548 / #1738, another attacker role): ONE PEER SEAT. #1548 bounded the rows the player's
// refused marks write and #1738 the refused first marks; but a close's evidence pull (Verifier #pullEvidenceBlocks, run on
// every close attempt and at the re-run window via pullEvidence) writes every { mark, block } a peer's GET /evidence-blocks
// names into evidence_blocks - no signature, no check the mark exists, no cap per entry. One committee seat answering with
// fresh made-up ids on each retry grows the entry's evidence_blocks at every honest seat without bound, and every honest
// seat then serves those rows on to the others from its own /evidence-blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { Verifier } from '../src/verify.js';

test('wf1489-v1-refute-55-s2-1: one peer seat cannot grow an entry\'s evidence_blocks without bound through the evidence pull', async () => {
  const N = 5000;
  let served = 0;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/evidence-blocks')) {
      const marks = [];
      for (let i = 0; i < N; i++) marks.push({ mark: randomBytes(32).toString('hex'), block: randomBytes(32).toString('hex'), seenMs: 0 });
      served += N;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ marks }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const peer = `http://127.0.0.1:${srv.address().port}`;
  try {
    const round = new Round(openStore(':memory:'));
    const v = new Verifier(round, { peers: [peer], pool: {} });
    const rid = randomBytes(32); const eid = randomBytes(32);
    // the close retries: three pulls (each close attempt / the re-run window pulls again)
    for (let i = 0; i < 3; i++) { try { await v.pullEvidence(rid, eid); } catch { /* the rest of the pull */ } }
    const n = round.evidenceBlocks(eid).length;
    console.log('  FACTS:', JSON.stringify({ served, evidenceRows: n }));
    assert.ok(n <= 256, `one peer seat wrote ${n} evidence_blocks rows for one entry at this seat (of ${served} it served) - no bound`);
  } finally { srv.close(); }
});
