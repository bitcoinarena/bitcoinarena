// kanban #3045: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit 2026-11-19 r4 play-r1-1: POST /first-mark pulls GET /receipts from EVERY peer (receiptsKnownOf, the #2838 fix) on every
// stranger request for a first mark this seat does not hold but has late evidence for - also once the seat has already recorded the
// ENTRY_VOID (the receipts are awaited before voidHere answers the held Void). The voided entry's first mark is public at GET /entry-void,
// so one stranger replaying it makes the seat fan out one request per peer per POST, with no cache (the #2353 "the peers are asked once
// per mark" rule does not cover this door). Safe: repeats of the same first mark at a seat that already holds the Void ask no peer again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sevenSignerNodes, joinWithTwoFirstMarks, voidAtZeroToThree, wait, toHex } from './five-of-seven-fixture.js';
import { splitSignedBatch } from '../../arena-protocol/src/batch.js';

test('audit-play-r4-1-1: replayed POST /first-mark of a voided entry pulls /receipts from every peer each time', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  const realFetch = globalThis.fetch;
  let receiptPulls = 0;
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voids = await voidAtZeroToThree(w, run);
    await w.back(4, 5, 6);
    const body = JSON.stringify({ mark: toHex(run.first[1]), batches: [toHex(splitSignedBatch(run.first[0]).body)],
      entryVoid: { kind: 'mark', evidence: toHex(run.past[1]) } });
    const port = w.signerNodes[4].port;
    // the first offer (a stranger, or the forward): seat 4 records the Void
    const first = await realFetch(`http://127.0.0.1:${port}/first-mark`, { method: 'POST', body });
    const firstSaid = { status: first.status, body: (await first.text()).slice(0, 160) };
    for (let t = Date.now(); Date.now() - t < 5000 && !w.signerNodes[4].round.entryVoid(run.eid); await wait(100));
    const voidAt4 = !!w.signerNodes[4].round.entryVoid(run.eid);
    const holds4 = !!w.signerNodes[4].round.firstMarkHeld(w.rid, run.eid);
    await wait(500);
    // now count every /receipts pull the seats make while a stranger replays the same request
    globalThis.fetch = (u, o) => { if (String(u).includes('/receipts?')) receiptPulls++; return realFetch(u, o); };
    const REPEATS = 20;
    const said = [];
    for (let i = 0; i < REPEATS; i++) {
      const r = await realFetch(`http://127.0.0.1:${port}/first-mark`, { method: 'POST', body });
      said.push(r.status); await r.text();
    }
    globalThis.fetch = realFetch;
    const facts = { voids, firstSaid, voidAt4, holds4, said: [...new Set(said)], receiptPulls, peers: w.signerNodes[4].verifier.peersOf(w.rid).length };
    console.log('  FACTS audit-play-r4-1-1:', JSON.stringify(facts));
    assert.equal(voidAt4, true, 'setup: seat 4 did not record the Void');
    assert.equal(holds4, false, 'setup: seat 4 holds the first mark');
    assert.ok(receiptPulls <= facts.peers,
      `${REPEATS} replays of one voided entry's public first mark made seat 4 pull GET /receipts ${receiptPulls} times (${facts.peers} peers)`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
