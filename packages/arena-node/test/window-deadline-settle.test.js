// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SPLIT ENTRY IS VOID AND LEFT OUT OF THE ROUND'S SETTLEMENT, AND THE OTHERS SETTLE (§13A/§13CRULED the owner
// 2026-10-04: "Node, 2-of-2 lockRound: the split entry is VOID, left out of settlement and payout ... the other entry
// settles"). Two running signer nodes (their own DKG), a winner, a loser and a third player whose run the two seats sign
// differently - seat B's own result one score higher, both seats up, all inside the window. Past final_after: that entry
// is VOID at both seats by the deadline (no run at 2 of 2 in time); the round settles without it - the loser's lock claimed,
// the winner paid from it - and the split entry's lock is neither claimed nor paid out: §23.2's VOID, "nothing is forfeited -
// nobody acts, and the lock returns to the player at its expiry".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, WINNER, LOSER, wait } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const SPLIT = { name: 'split', key: b32(7), worldSecret: b32(0xc1), ticks: 1000 };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);

test('a split entry is VOID at the deadline and left out of the settlement; the winner is paid from the loser; its lock returns to its player at expiry', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    const lost = await lockAndPlay(w, LOSER);
    const split = await lockAndPlay(w, SPLIT);
    await closeRound(w, { window: false });
    const signed = () => [w.a, w.b].every((d) => [won, lost, split].every((p) => d.round.results(w.rid, p.eid).length === 2));
    assert.ok(await until(signed), 'the two seats did not both sign all three runs');
    // SEAT B'S RESULT FOR THE SPLIT ENTRY, ONE SCORE HIGHER, held by both seats inside the window: 1 - 1, both up
    const honestB = decodePlayerResult(splitSignedResult(w.b.round.results(w.rid, split.eid).find((r) => toHex(r.nodePubkey) === toHex(w.b.round.pubkey)).bytes).body);
    const forged = { ...honestB, score: (honestB.score + 1) >>> 0 };
    const bytes = joinSignedResult(encodePlayerResult(forged), schnorr.sign(resultId(forged), w.b.round.identity.secret));
    for (const d of [w.a, w.b]) {
      d.round.db.prepare('DELETE FROM results WHERE round_id = ? AND entry_id = ? AND node_pubkey = ?').run(w.rid, split.eid, w.b.round.pubkey);
      d.round.putResult(w.rid, split.eid, w.b.round.pubkey, resultId(forged), bytes);
    }
    const inWindow = [w.a, w.b].map((d) => stateAt(d, w, split.eid).state);
    // THE OTHER TWO PUBLISHED IN TIME, then past final_after
    const published = () => [w.a, w.b].every((d) => [won, lost].every((p) => { const f = stateAt(d, w, p.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; }));
    assert.ok(await until(published), 'the winner and the loser were not published in time');
    skipTo(Number(windowsOf(w.c).finalAfterMs) + 50);
    const got = await untilSettled(w, 60000);
    const splitAt = [w.a, w.b].map((d) => stateAt(d, w, split.eid));
    const paid = [...w.port.payouts.values()];
    const claims = (w.port.settlements[0] && w.port.settlements[0].claims || []).map((c) => key(c.outpoint));
    const names = { [key(lost.outpoint)]: 'loser stake', [key(lost.feeOutpoint)]: 'loser fee', [key(won.outpoint)]: 'WINNER STAKE',
      [key(won.feeOutpoint)]: 'winner fee', [key(split.outpoint)]: 'SPLIT STAKE', [key(split.feeOutpoint)]: 'SPLIT FEE' };
    const name = (k) => names[k] || k;
    const forfeit = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(split.eid)}`);
    const forfeitText = (await forfeit.text()).trim();
    const after = w.a.settlements.lockAfterSettlement(w.rid, split.eid);
    console.log('  FACTS (split in a lock round):', JSON.stringify({ inWindow, split: splitAt.map((f) => [f.state, f.why]), settled: got.state,
      claims: claims.map(name),
      payouts: paid.map((p) => [String(p.msat), toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)) ? 'winner' : toHex(p.payoutPk).slice(0, 12)]),
      splitLockHeld: w.port.locks.has(key(split.outpoint)), splitFeeHeld: w.port.locks.has(key(split.feeOutpoint)), forfeit: [forfeit.status, forfeitText], after: after.why,
      others: [won, lost].map((p) => stateAt(w.a, w, p.eid).state) }));
    assert.deepEqual(inWindow, [null, null], 'a split was decided inside the window');
    for (const f of splitAt) {
      assert.equal(f.state, 'VOID', f.why);
      assert.match(f.why, /^no result at the threshold by .*: 1 of 2 matching results held in time - .* \(§13C\)$/);
    }
    assert.equal(got.state, 'ACCEPTED', got.why);
    // the loser's stake, and the fee locks of the two entries that settle (the seats' fee) - nothing of the split entry's
    assert.deepEqual(claims.map(name).sort(), ['loser fee', 'loser stake', 'winner fee'], 'the settlement claimed another lock');
    assert.equal(w.port.locks.has(key(split.feeOutpoint)), true, 'the split entry\'s fee lock was touched');
    const toWinner = paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    assert.equal(toWinner.length, 1, 'the winner was not paid once');
    assert.equal(paid.some((p) => toHex(p.payoutPk) === toHex(refundKeyOf(SPLIT.key))), false, 'the split entry was paid');
    assert.equal(w.port.locks.has(key(split.outpoint)), true, 'the split entry\'s lock was touched');
    assert.equal(forfeit.status, 409);
    assert.match(forfeitText, /that entry is VOID \(§13C\): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry/);
    assert.deepEqual([won, lost].map((p) => stateAt(w.a, w, p.eid).state), ['FINAL', 'FINAL']);
  } finally { await w.close(); }
});
