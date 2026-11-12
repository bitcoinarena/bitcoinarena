// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-find-entry 4 (state machine audit, entry): TWO ENTRIES OF ONE PLAYER KEY, THEIR LOCKS RACING, SPLIT THE SEATS.
// The door takes a second entry of a player key in a round (only the session key must be new, #1479), and since #1215 a seat stakes
// only ONE entry per player key: the first whose lock it verifies; the other entry's lock is refused there ("another entry of that player
// key is already staked"). Which one is first is each seat's own arrival order. The player's key in a round is derived from the seed, so
// two entries under one key are what a reload mid-join (the old tab's lock already handed to some seats, the new PLAY's lock to all) or
// the same seed on two devices make - and what a player who wants a round never to settle makes on purpose. Seat 0 stakes entry 1 and
// seat 1 entry 2, for good (takeEntryParts' pull and the relay are refused the same way): each seat's settlement claims another lock,
// the 2-of-2 threshold never meets, the winner is never paid and every stake waits for its lock's expiry.
// Invariant: seats of one round stake the same entries (and so build one settlement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, nameAddress } from './lock-round-fixture.js';
import { WINNER, LOSER, b32, wait } from './window-fixture.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });

test('#1489 sm1-entry-4 two entries of one player key whose locks land in another order at two seats do not split the committee', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    await nameAddress([w.a, w.b], won);
    // ONE PLAYER KEY, TWO ENTRIES (a reload mid-join, or the seed on two devices): both entries reach both seats, no lock yet
    // (kanban #2477: the locks are handed below by the test itself, so the entry relay's timing does not decide which seat sees which first)
    const who = (name) => ({ ...LOSER, name, key: b32(0x21) });
    const one = await lockAndPlay(w, who('tab-1'), { noMarks: true, only: [] });
    const two = await lockAndPlay(w, who('tab-2'), { noMarks: true, only: [] });
    const hand = async (d, p) => {
      const base = `http://127.0.0.1:${d.port}`;
      const l = await fetch(`${base}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
      const lockWhy = (await l.text()).slice(0, 100);
      const f = await fetch(`${base}/fee-lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(p))) });
      await f.text();
      return { lock: l.status, lockWhy, fee: f.status };
    };
    // entry 1's locks land at seat 0 first and entry 2's at seat 1 first, at the same moment ...
    const first = await Promise.all([hand(w.a, one), hand(w.b, two)]);
    // ... and then each entry's locks reach the other seat too (the page hands every seat; the relay hands them on)
    const late = [await hand(w.b, one), await hand(w.a, two)];
    for (let i = 0; i < 20; i++) await wait(10);   // a relay hand-on still under way lands
    const staked = (d) => ({ one: !!d.round.stakeSeen(one.eid), two: !!d.round.stakeSeen(two.eid) });
    const at = { seat0: staked(w.a), seat1: staked(w.b) };
    await closeRound(w);
    const st = await untilSettled(w, 45000);
    for (let i = 0; i < 4; i++) await wait(10);
    console.log('  FACTS sm1-entry-4:', JSON.stringify({ first, late, lower: Buffer.compare(Buffer.from(one.eid), Buffer.from(two.eid)) < 0 ? 'one' : 'two', staked: at, settlement: st && st.state, why: String(st && st.why).slice(0, 160) }));
    assert.deepEqual(at.seat0, at.seat1, 'the two seats of the round stake different entries of one player key: each builds another settlement');
    assert.equal(Number(at.seat0.one) + Number(at.seat0.two), 1, 'one entry of the key is staked, not none and not both');
    assert.equal(st.state, 'ACCEPTED', `the round never settles - the winner is not paid: ${st && st.why}`);
  } finally { await w.close(); }
});
