// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2592 (attack audit, settlement): A LOCKLESS COPY OF A WINNER'S ENTRY KEPT THE WINNER FROM ITS LATE SHARE.
// The late loser's second settlement found each winner's lock by player key over EVERY entry of the round (settlement.js
// lateMessage, byPlayer). An entry carries no player signature, so anyone - the late loser himself - posted a copy of the
// winner's entry under a fresh session key, its entry id ground to sort after the winner's: byPlayer then named the copy,
// which holds no lock, the winner had "no key to pay", and the late lock was never claimed - it went back to the loser at
// its expiry. The winner's lock is read from the entry that holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { resultFinality } from '../src/finality.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { b32, WINNER, LOSER, wait } from './window-fixture.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const LATE = { name: 'late', key: b32(6), worldSecret: b32(0xc1), ticks: 1000 };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

test('#2592 a lockless copy of the winner\'s entry, sorted after it, does not keep the winner from the late loser\'s stake', async () => {
  const view = new Map();
  const finalityOf = (round, rid, eid) => (view.has(toHex(eid)) ? view.get(toHex(eid))(round, rid, eid) : resultFinality(round, rid, eid));
  const w = await lockRound({ serveOpts: { finalityOf, finality: { everyMs: 100, lateEveryMs: 200 } } });
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    await lockAndPlay(w, LOSER);
    const late = await lockAndPlay(w, LATE);
    // THE ATTACK: the winner's public entry again, under a fresh session key, ground until its id sorts after the winner's
    let copy;
    do copy = { ...won.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    while (toHex(entryId(copy)) < toHex(won.eid));
    for (const d of [w.a, w.b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(copy) });
      assert.equal(r.status, 201, `the copy was not taken: ${await r.text()}`);
    }
    view.set(toHex(late.eid), () => ({ state: 'SUSPENDED', why: 'test view: in its re-run window' }));
    for (const d of [w.a, w.b]) d.round.object(w.rid, late.eid);
    await closeRound(w);
    const first = await untilSettled(w);
    assert.equal(first.state, 'ACCEPTED', first.why);
    view.delete(toHex(late.eid));    // the late run ends FINAL and FAILED
    let rows = [];
    for (const stop = Date.now() + 15000; Date.now() < stop; await wait(200)) {
      rows = [w.a, w.b].map((d) => d.round.lateLockSettlement(w.rid, late.eid));
      if (rows.every((r) => r && r.state === 'ACCEPTED')) break;
    }
    const direct = await proposerOf(w).settlements.lateMessage(w.rid, late.eid, { onlyBase: true });
    const second = w.port.settlements.find((x) => x.claims.some((c) => key(c.outpoint) === key(late.outpoint)));
    console.log('#2592 FACTS:', JSON.stringify({ states: rows.map((r) => r && r.state), why: direct.ok ? null : direct.why,
      winnerPaid: second ? second.payouts.filter((p) => p.kind !== 'signer node').map((p) => toHex(p.payoutPk).slice(0, 16)) : null }));
    assert.equal(direct.ok, true, direct.why);
    assert.deepEqual(rows.map((r) => r && r.state), ['ACCEPTED', 'ACCEPTED'], 'the late loser\'s stake was never claimed');
    assert.ok(second, 'no second settlement claimed the late lock');
    assert.deepEqual(second.payouts.filter((p) => p.kind !== 'signer node').map((p) => toHex(p.payoutPk)), [toHex(refundKeyOf(won.entry.playerPubkey))]);
  } finally { await w.close(); }
});
