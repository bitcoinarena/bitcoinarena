// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §15 AT THE DOOR, NEVER A REFUND (the accepted series sequence, step 5, 2026-09-29): in a lock round with a winner,
// a seated player whose stake is locked and who sends no first mark is FORFEIT 0 at both signer nodes at the door, never
// ENTRY_VOID - and at the round's settlement that stake lock is claimed with the losers', not left to expire back.
// (A round with NO qualifier leaves every lock to expire back - the no-qualifier rule of winnings-sent - measured apart.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, nameAddress } from './lock-round-fixture.js';
import { WINNER, LOSER, b32, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';

test('a walk-away beside a winner: FORFEIT 0 at both at the door, never ENTRY_VOID, and its stake lock claimed by the settlement', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    await nameAddress([w.a, w.b], won);
    const results = (d) => d.round.results(w.rid, walker.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
    for (const stop = Date.now() + 60000; Date.now() < stop && !(results(w.a).length && results(w.b).length); await wait(250));
    const at = { a: results(w.a).map((r) => [r.outcome, r.score]), b: results(w.b).map((r) => [r.outcome, r.score]),
      entryVoid: [w.a.round.entryVoid(walker.eid), w.b.round.entryVoid(walker.eid)] };
    console.log('  FACTS (door):', JSON.stringify(at));
    assert.deepEqual(at.a, [['FORFEIT', 0]]); assert.deepEqual(at.b, [['FORFEIT', 0]]);
    assert.deepEqual(at.entryVoid, [null, null], 'never ENTRY_VOID');
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    const key = `${toHex(walker.outpoint.txid)}:${walker.outpoint.outIdx}`;
    const claimed = port.settlements.some((x) => (x.claims || []).some((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}` === key));
    console.log('  FACTS (settled):', JSON.stringify({ state: st.state, why: String(st.why).slice(0, 160), walkerLockClaimed: claimed, walkerLockStillHeld: port.locks.has(key) }));
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(claimed, 'the walker\'s stake lock is not among the settlement\'s claims');
    assert.equal(port.locks.has(key), false, 'the walker\'s stake lock is left to expire back - a refund');
  } finally { await w.close(); }
});
