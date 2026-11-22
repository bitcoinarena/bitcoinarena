// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 71 (fix #1757): THE SEAT combinedElsewhere EXISTS FOR CAN NO LONGER READ A GENUINE COMBINE.
// verifier.combinedElsewhere is for "a node that was down across [the combine] (measured: B came back after the combine, held its close
// for ever and never signed)" and for the seat holding the pending final mark. #1757 now counts a peer's verifying signature only over a
// message this seat ties to the round: a pair it handed out (in memory - gone after a restart, and never made while its own build refuses),
// its txid history (written only from its own build), or settlements.message(rid) rebuilt from its store. But that seat is exactly the one
// that has NOT signed its result for the held entry yet - entriesOnRecord refuses "this signer node signed no result for ..., so it settles
// nothing" - so all three are empty, and the threshold's real, verifying settlement of THIS round reads "not combined": the hold never ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, untilSettled, nameAddress, standing } from './lock-round-fixture.js';
import { WINNER, LOSER } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a seat that has not signed its result yet (held close, after a restart) still reads the threshold\'s own combined settlement of this round as combined', async () => {
  const w = await lockRound({});
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress([w.a, w.b], won);
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const genuine = await standing(w.a, w);
    assert.ok(genuine.signature && genuine.message, 'the round\'s own combined settlement, at the peer');
    // SEAT B AS THE HELD SEAT IS: restarted (no pairs in memory, no build cached), nothing of its own built (no txid history), and
    // its own result for an entry not signed yet (it holds its close) - each the state of the store, not a stub of the check
    const b = w.b;
    b.settlements.pairs = new Map();
    b.settlements.built = new Map();
    b.settlements.byPlan = new Map();
    b.round.settlementTxidsOf = () => [];
    const results = b.round.results.bind(b.round);
    b.round.results = (rid, eid) => results(rid, eid).filter((r) => toHex(r.nodePubkey) !== toHex(b.round.pubkey));
    const own = await b.settlements.message(w.rid);
    assert.equal(own.ok, false, 'precondition: the held seat cannot rebuild the settlement');
    const peers = b.verifier.peers;
    b.verifier.peers = [`http://127.0.0.1:${w.a.port}`];
    const said = await b.verifier.combinedElsewhere(w.rid);
    b.verifier.peers = peers;
    console.log('  FACTS:', JSON.stringify({ ownBuild: own.why, peerState: genuine.state, combinedElsewhere: said }));
    assert.equal(said, true, 'the threshold\'s genuine combined settlement of THIS round, verifying under its claim key, read "not combined" at the held seat: its close is held for ever');
    // AND ONLY THIS ROUND'S TRANSACTION, REBUILT TO THE SIGNED MESSAGE (kanban #2176): its parts as the peer serves them tie it; a payout
    // changed rebuilds another message, and the same parts with every claim moved to an outpoint of no lock of this round tie nothing
    const tx = (await (await fetch(`http://127.0.0.1:${w.a.port}/lock-settlement?round=${toHex(w.rid)}&tx=1`)).json()).tx;
    assert.ok(tx && tx.claims.length, 'the ACCEPTED row carries its transaction\'s parts when asked');
    assert.equal(await b.settlements.isRoundsTx(w.rid, tx, genuine.message), true);
    const paidElsewhere = { ...tx, payouts: tx.payouts.map((p, i) => (i ? p : { ...p, msat: String(BigInt(p.msat) - 1n) })) };
    assert.equal(await b.settlements.isRoundsTx(w.rid, paidElsewhere, genuine.message), false, 'a changed payout is not the signed message');
    const otherLocks = { ...tx, claims: tx.claims.map((c) => ({ ...c, outpoint: `${'ab'.repeat(32)}:0` })) };
    assert.equal(await b.settlements.isRoundsTx(w.rid, otherLocks, genuine.message), false, 'no lock of this round spent: not this round\'s');
    const notAsked = await (await fetch(`http://127.0.0.1:${w.a.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
    assert.equal(notAsked.tx, undefined, 'the parts only when asked');
  } finally { await w.close(); }
});
