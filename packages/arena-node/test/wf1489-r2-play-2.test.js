// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (play path): ONE SEAT'S UNPROVEN "closed" CLAIM VOIDS A PLAYER'S ON-TIME START AT AN OPEN SEAT.
// POST /first-mark (and the /play door's lateByPeers, which reads a peer's GET /entry-void the same way) takes
// `entryVoid: { kind: 'closed' }` plus the claimer's own receipt of the player's first mark as proof that the start
// deadline passed (lateEvidenceHere), and voidHere then records ENTRY_VOID with the receipts the claimer chose to hand
// over. Nothing shows the round closed: the receipt only shows the claimer saw the mark. So one seat that got the
// player's on-time first mark can, while the round is open and long before its end on the honest seat's clock, make the
// honest seat record ENTRY_VOID and refuse the player's own first mark ('error ENTRY_VOID') - the run is never played
// there and the entry goes to the outage refund. Safe: an open round whose end has not come on this seat's clock takes
// no other seat's "closed" word; the player's own on-time first mark is taken.
import { test } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signerNodes, joinAndBuild, answer, assert, say, toHex, checkpointId } from './first-mark-fixture.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';

test('#1489-r2-play-2: one seat\'s "closed" claim with its own receipt does not void an on-time first mark at a seat whose round is open', async () => {
  const w = await signerNodes({ endIn: 60000 });
  try {
    const run = await joinAndBuild(w);
    // SEAT B IS THE LIAR: it got the player's first mark (the player sends to every seat) and signs its own receipt of it
    const r = { checkpointId: run.firstId, receivedAtMs: BigInt(Date.now()), nodePubkey: w.b.round.pubkey };
    const bReceipt = joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), w.b.round.identity.secret));
    const posted = await fetch(`http://127.0.0.1:${w.a.port}/first-mark`, { method: 'POST', body: JSON.stringify({
      mark: toHex(run.messages[1]), batches: [toHex(run.messages[0])], receipt: toHex(bReceipt), receipts: [],
      entryVoid: { kind: 'closed', evidence: null } }) });
    let got = {}; try { got = await posted.json(); } catch { got = {}; }
    // AND THEN THE PLAYER ITSELF, ON TIME, AT SEAT A
    const said = [];
    for (const m of run.messages.slice(0, 2)) said.push(answer(await say(w.a.port, m)));
    const facts = { roundOpenAtA: w.a.round.get(w.rid).state === 0, posted: posted.status, postedEntryVoid: !!got.entryVoid,
      aRecordsEntryVoid: !!w.a.round.entryVoid(run.eid), playerSaid: said, aHoldsFirstMark: w.a.round.holdsMark(run.firstId) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(facts.roundOpenAtA, true);
    assert.equal(facts.aRecordsEntryVoid, false, 'one seat\'s unproven "closed" claim made the open seat record ENTRY_VOID');
    assert.equal(facts.aHoldsFirstMark, true, 'the player\'s own on-time first mark was refused at the open seat');
  } finally { await w.close(); }
});
