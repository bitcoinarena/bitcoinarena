// kanban #3357: the card's test (audit entry a6-2-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT entry r2 (a6-2-1): GET /forfeit of an ENTRY_VOID entry whose refund does not combine re-forwards the player's first mark
// (with its batches, receipts and the Void's evidence) to every committee peer on EVERY request - forfeit.js #forfeitOnce calls
// onVoid -> server.js pushVoid -> forwardFirstMark each pass. #2854 gated only the proof pull of the same door (pullProofReachOnce);
// this second peer fan-out of the same public GET is not gated. A stranger who knows the public round and entry id repeats the GET.
// SAFE: repeated asks within a moment do not hand the same Void on to the same peer again and again (at most a couple of forwards).
import { test } from 'node:test';
import { signerNodes, joinAndBuild, say, wait, toHex, assert } from './first-mark-fixture.js';

test('a6-2-1: repeated GET /forfeit of an ENTRY_VOID entry does not re-POST /first-mark to every peer on each request', async () => {
  const w = await signerNodes();
  const orig = globalThis.fetch;
  let forwards = 0;
  try {
    const run = await joinAndBuild(w);
    // the batch and the on-time first mark at both seats (both receipt it)
    for (const m of run.messages.slice(0, 2)) for (const d of [w.a, w.b]) await say(d.port, m);
    for (let t = Date.now(); Date.now() - t < 5000 && !w.a.round.holdsMark(run.firstId); await wait(100));
    assert.ok(w.a.round.holdsMark(run.firstId), 'seat A holds the first mark');
    // seat A's own record of an outage Void (as after an outage at the start deadline); seat B holds no Void, so the refund
    // never combines at 2 of 2 and every GET /forfeit at A fails - the state a stranger can keep asking about
    const mark = w.a.round.firstMarkHeld(w.rid, run.eid);
    w.a.round.putEntryVoid({ entryId: run.eid, roundId: w.rid, firstMark: mark, evidenceKind: 'closed', evidence: null, why: 'test: outage at the start deadline' });
    assert.ok(w.a.round.entryVoid(run.eid));
    const bFirstMark = `127.0.0.1:${w.b.port}/first-mark`;
    globalThis.fetch = (u, o) => { if (String(u).includes(bFirstMark)) forwards += 1; return orig(u, o); };
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const r = await orig(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
      statuses.push(r.status); await r.text();
    }
    console.log('  FACTS:', JSON.stringify({ statuses, forwardsToB: forwards }));
    assert.ok(statuses.every((s) => s !== 200), 'the refund does not combine (B holds no Void)');
    assert.ok(forwards <= 2, `10 stranger GET /forfeit made ${forwards} POST /first-mark forwards to seat B (one per request)`);
  } finally { globalThis.fetch = orig; await w.close(); }
});
