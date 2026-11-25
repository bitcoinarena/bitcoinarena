// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3678 (audit #1489 of 2026-11-25, gossip), fix-does-not-hold of #1559: ONE PEER'S seenMs STILL BACKDATES A MARK THIS SEAT
// RECORDED LATE. Verifier#pullEvidenceBlocks passes a peer's unsigned x.seenMs to round.notePulledEvidenceBlock, whose merge keeps
// MIN(seen_ms, peer's) on this seat's OWN record (same mark, same block) and whose insert keeps the peer's time on a new row; markCounts
// with end.untilMs (finality.js window, WINDOW-10-SPEC) counts a mark when any row's seen_ms is before the decision instant.
// Safe behaviour: a mark this seat first recorded after the decision instant does not count in that window on one peer's word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Verifier } from '../src/verify.js';

const b = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');

function withPeer(answer, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/evidence-blocks')) return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('no', { status: 404 });
  };
  return run().finally(() => { globalThis.fetch = real; });
}

for (const same of [true, false]) test(`one peer's seenMs: 1 does not make a late-recorded mark count (${same ? 'same block: merge' : 'other block: new row'})`, async () => {
  let now = 5000;
  const round = new Round(openStore(':memory:'), () => now);
  const v = new Verifier(round, { peers: ['http://evil.peer'], pool: {} });
  const rid = b(1), eid = b(2), mark = b(3), block = b(9);
  const untilMs = 4000n;            // the decision instant; this seat first held the mark at 5000, after it
  round.noteEvidenceBlock(rid, eid, mark, block);
  assert.equal(round.markCounts(eid, mark, null, { untilMs }), false, 'control: recorded after the instant, it does not count');
  await withPeer({ marks: [{ mark: hex(mark), block: hex(same ? block : b(10)), seenMs: 1 }] }, () => v.pullEvidence(rid, eid));
  const rows = round.db.prepare('SELECT seen_ms, pulled_from FROM evidence_blocks WHERE entry_id = ?').all(eid);
  console.log('  FACTS:', JSON.stringify(rows));
  assert.equal(round.markCounts(eid, mark, null, { untilMs }), false, 'one peer\'s seenMs: 1 made a mark this seat recorded late count in the window');
});
