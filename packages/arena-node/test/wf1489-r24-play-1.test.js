// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r24-play-1: POST /first-mark's ENTRY_VOID door counts only the receipts the CALLER hands over. A seat that
// missed the first mark (down at the start) and is offered it by anyone - with a later player mark as "evidence" and a
// chosen SUBSET of the public receipts (needed - 1) - records ENTRY_VOID for a run five seats receipted and that is live.
// Safe: a run whose first mark is carried by `needed` committee members is never ENTRY_VOID at any seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sevenSignerNodes, joinWithTwoFirstMarks, say, wait, toHex, NEEDED, SIGNED_RECEIPT_BYTES } from './five-of-seven-fixture.js';
import { splitSigned, decodeCheckpoint, checkpointId } from '../../arena-protocol/src/checkpoint.js';
import { splitSignedBatch } from '../../arena-protocol/src/batch.js';
import { splitSignedReceipt, decodeCheckpointReceipt } from '../../arena-protocol/src/receipt.js';

test('r24-play-1: a stranger with needed-1 public receipts makes a seat that missed the first mark record ENTRY_VOID for a live run', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    await w.down(5, 6);                                                   // two seats down at the start
    for (const i of [0, 1, 2, 3, 4]) for (const m of [...run.first, ...run.past]) await say(w.signerNodes[i].port, m);
    const firstId = checkpointId(decodeCheckpoint(splitSigned(run.first[1]).body));
    for (let t = Date.now(); Date.now() - t < 8000 && w.signerNodes[0].round.receiptCount(firstId) < NEEDED; await wait(200));
    const carried = w.signerNodes[0].round.receiptCount(firstId);
    const voidsBefore = [0, 1, 2, 3, 4].map((i) => (w.signerNodes[i].round.entryVoid(run.eid) ? 1 : 0));
    // the public receipts of the first mark, from seat 0
    const r = await fetch(`http://127.0.0.1:${w.signerNodes[0].port}/receipts?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    const all = new Uint8Array(await r.arrayBuffer());
    const ofFirst = [];
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= all.length; at += SIGNED_RECEIPT_BYTES) {
      const one = all.slice(at, at + SIGNED_RECEIPT_BYTES);
      if (toHex(decodeCheckpointReceipt(splitSignedReceipt(one).body).checkpointId) === toHex(firstId)) ofFirst.push(one);
    }
    await w.back(5);
    // the stranger, at once: the player's public first mark, its public batch, a later public mark, and NEEDED - 1 receipts
    const posted = await fetch(`http://127.0.0.1:${w.signerNodes[5].port}/first-mark`, { method: 'POST', body: JSON.stringify({
      mark: toHex(run.first[1]), batches: [toHex(splitSignedBatch(run.first[0]).body)],
      entryVoid: { kind: 'mark', evidence: toHex(run.past[1]) }, receipts: ofFirst.slice(0, NEEDED - 1).map(toHex) }) });
    const said = { status: posted.status, body: await posted.text() };
    const facts = { carried, receiptsPublic: ofFirst.length, voidsBefore, said, voidAt5: !!w.signerNodes[5].round.entryVoid(run.eid) };
    console.log('  FACTS r24-play-1:', JSON.stringify(facts));
    assert.ok(carried >= NEEDED, `setup: the first mark is carried by ${carried} < ${NEEDED}`);
    assert.deepEqual(voidsBefore, [0, 0, 0, 0, 0], 'setup: a seat that took the live run voided it');
    assert.equal(facts.voidAt5, false, `seat 5 recorded ENTRY_VOID for a run ${carried} seats receipted, on ${NEEDED - 1} receipts a stranger chose: ${said.body}`);
  } finally { await w.close(); }
});
