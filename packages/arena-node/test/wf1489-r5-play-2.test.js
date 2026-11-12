// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r5 (play) 2: A FIRST MARK WHOSE SIGNATURE DOES NOT VERIFY IS NEVER FORWARDED, AND CHANGES NO EVIDENCE.
//
// The /play door hands every first-mark frame to forwardFirstMark after the handler answers - whether the mark was
// taken or refused. forwardFirstMark decides "held" from the mark's BODY (checkpointId), never its signature, so a
// stranger who copies the player's real first mark from the public GET /checkpoints and puts 64 zero bytes where the
// signature goes makes the seat POST that forged mark to every other seat that has not receipted it. Each one refuses it
// (409, the signature) and the seat records that seat's answer to the player's on-time first mark as 'refused' - over
// the 'unanswered' it recorded while that seat was down. §16 (outageOutcome) reads a 'refused' as "that seat was up and
// refused it - not an outage": the player's ENTRY_VOID refund for a real outage is gone, at no cost, repeatable.
import { test } from 'node:test';
import { assert, signerNodes, joinAndBuild, say, wait, toHex } from './first-mark-fixture.js';
import { outageOutcome } from '../../arena-protocol/src/entry-void.js';

test('wf1489-r5-play-2: a stranger\'s copy of the first mark with a bad signature is not forwarded and flips no seat\'s recorded answer', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    // B IS DOWN when the player starts: A takes the first batch and mark and its forward to B goes unanswered (§16's evidence)
    await w.downB();
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    let before = null;
    for (let t = Date.now(); Date.now() - t < 8000 && !before; await wait(100)) {
      const o = w.a.round.firstMarkOffers(run.eid);
      if (Object.keys(o).length) before = { ...o };
    }
    await w.upB();
    // B is back. A STRANGER copies the first mark (public at GET /checkpoints) and zeroes its signature
    const marks = new Uint8Array(await (await fetch(`http://127.0.0.1:${w.a.port}/checkpoints?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).arrayBuffer());
    const forged = marks.slice(0, run.messages[1].length);
    forged.fill(0, forged.length - 64);
    const said = await say(w.a.port, forged);
    await wait(1500);
    const after = { ...w.a.round.firstMarkOffers(run.eid) };
    const decide = (offers) => outageOutcome({ firstMark: true, deadlinePassed: true, receipts: 1, needed: 2, offers: Object.values(offers) }).outcome;
    console.log(`  stranger's frame answered: ${String(said).slice(0, 90)}`);
    console.log(`  A's record of the seats' answers: before ${JSON.stringify(before)} (outage: ${decide(before || {})}); after ${JSON.stringify(after)} (outage: ${decide(after)})`);
    assert.ok(before && Object.values(before).includes('unanswered'), `the down seat's answer was not recorded: ${JSON.stringify(before)}`);
    assert.deepEqual(after, before, 'a forged first mark that does not verify changed the seat\'s §16 evidence (the outage refund is gone)');
  } finally { await w.close(); }
});
