// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 (gossip): A PEER'S "COMBINED ELSEWHERE" ANSWER MUST BE THE SETTLEMENT OF THIS ROUND.
// verifier.combinedElsewhere (server.js) asks each peer GET /lock-settlement?round=<rid> and believes the round's settlement combined when the answer's
// signature verifies under the round's claim key over THE MESSAGE THE ANSWER NAMES. The claim key is the committee's DKG key (dkg.signerNodeFor(nodes)),
// the same for every round of that committee - so one peer that hands back an earlier round's ACCEPTED settlement (public at GET /lock-settlement)
// makes this seat believe a round that was never settled is combined. verify.js #combined then ends the held-back final mark's wait (#holdBack: the
// stopped transcript is signed, never the DELIVERED one) and skips the pending-final-mark hold. Safe: only a signature over THIS round's settlement
// message counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockRound, openLockRound, lockAndPlay, closeRound, untilSettled, nameAddress, standing } from './lock-round-fixture.js';
import { WINNER, LOSER } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('an earlier round\'s combined settlement handed back by one peer does not make a new round of the same committee "combined elsewhere"', async () => {
  const w = await lockRound({});
  let stub;
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress([w.a, w.b], won);
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const old = await standing(w.a, w);
    assert.ok(old.signature && old.message, 'the settled round shows its combined signature and message');
    // A NEW ROUND OF THE SAME TWO SEATS: nothing played, nothing settled
    const w2 = await openLockRound(w, { endMs: testNow() + 600000 });
    assert.notEqual(toHex(w2.rid), toHex(w.rid));
    assert.equal(toHex(w2.claimPk), toHex(w.claimPk), 'the same committee, the same claim key');
    assert.notEqual((await standing(w.a, w2)).state, 'ACCEPTED');
    // THE ATTACKER: one peer that answers every GET /lock-settlement with the old round's public answer
    stub = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(old)); });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const peers = w.b.verifier.peers;
    w.b.verifier.peers = [`http://127.0.0.1:${stub.address().port}`];
    const said = await w.b.verifier.combinedElsewhere(w2.rid);
    // AND THE SAME ANSWER FOR ITS OWN ROUND still reads combined (kanban #1757: the fix binds, it does not shut the door)
    const own = await w.b.verifier.combinedElsewhere(w.rid);
    w.b.verifier.peers = peers;
    console.log('  FACTS:', JSON.stringify({ oldRound: toHex(w.rid).slice(0, 16), newRound: toHex(w2.rid).slice(0, 16), combinedElsewhere: said, ownRound: own }));
    assert.equal(own, true, 'the settled round\'s own combined answer is still believed');
    assert.equal(said, false, 'one peer\'s replay of another round\'s settlement made a never-settled round "combined elsewhere"');
  } finally { if (stub) stub.close(); await w.close(); }
});
