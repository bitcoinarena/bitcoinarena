// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND WITH A NO-QUORUM ENTRY WAITS FOR IT, AND A RESCUED WINNER IS PAID IN FULL (§13A, RULED 2026-11-02, kanban #1047). Two running seats (their own DKG, the fake federation) at
// protocol 22: a winner, a loser and a third player, whose two signed results differ at final_after with both seats up, so no quorum. The seats' own re-runs of the honest replay
// agree inside the re-run window, the own window closes, FINAL, and only then the round settles with that entry in the table. With the seats' re-runs apart the entry is
// VOID at end + 1205 s and the round settles then, without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait, qualifiersUnder } from './window-fixture.js';
import { ROUND } from './protocol22-fixture.js';
import { skipTo } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { resultFinality, NO_RUN } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun } from '../../arena-protocol/src/rerun.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const OPTS = { serveOpts: { plugins: [NEXTBLOCK], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], finality: { everyMs: 100, lateEveryMs: 200 } }, round: ROUND };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);

/** Three players, the third's results one score apart at the two seats, both held in time; the other two published; the clock past final_after. */
async function splitRound(w) {
  const [q1, q2] = await qualifiersUnder(w.randomness, 2);
  // THE THIRD PLAYER IS THE ROUND'S BEST: up to four qualifiers the first rank takes the pool (§18A), so left out it would go to the other winner
  const won = await lockAndPlay(w, q2, { address: true });
  const lost = await lockAndPlay(w, LOSER);
  const x = await lockAndPlay(w, q1, { address: true });
  await closeRound(w, { window: false });
  assert.ok(await until(() => [w.a, w.b].every((d) => [won, lost, x].every((p) => d.round.results(w.rid, p.eid).length === 2))), 'the seats did not sign all three runs');
  const honest = decodePlayerResult(splitSignedResult(w.b.round.results(w.rid, x.eid).find((r) => toHex(r.nodePubkey) === toHex(w.b.round.pubkey)).bytes).body);
  const forged = { ...honest, score: (honest.score + 1) >>> 0 };
  const bytes = joinSignedResult(encodePlayerResult(forged), schnorr.sign(resultId(forged), w.b.round.identity.secret));
  for (const d of [w.a, w.b]) {
    d.round.db.prepare('DELETE FROM results WHERE round_id = ? AND entry_id = ? AND node_pubkey = ?').run(w.rid, x.eid, w.b.round.pubkey);
    d.round.putResult(w.rid, x.eid, w.b.round.pubkey, resultId(forged), bytes);
  }
  skipTo(Number(windowsOf(w.c).openMs) + 1000);
  assert.ok(await until(() => [w.a, w.b].every((d) => [won, lost].every((p) => { const f = stateAt(d, w, p.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; }))), 'the other two were not published in time');
  return { won, lost, x, honest };
}

test('a no-quorum entry rescued in the window holds the round, ends FINAL, and its winner is paid a full share of one settlement', { timeout: 115000 }, async () => {
  const w = await lockRound(OPTS);
  try {
    const { won, lost, x } = await splitRound(w);
    const win = windowsOf(w.c);
    skipTo(Number(win.finalAfterMs) + 50);
    const first = [w.a, w.b].map((d) => stateAt(d, w, x.eid));
    assert.deepEqual(first.map((f) => f.state), ['SUSPENDED', 'SUSPENDED'], first[0].why);
    // BOTH SEATS RE-RUN THE HONEST REPLAY BY THEMSELVES, AND IT IS AGREED AND POSTED
    assert.ok(await until(() => [w.a, w.b].every((d) => { const f = stateAt(d, w, x.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; })),
      `no agreed, posted re-run: ${stateAt(w.a, w, x.eid).why}`);
    await wait(1500);                                                          // settle passes: none may run
    const nothing = await standing(w.a, w);
    assert.equal(w.port.settlements.length, 0, 'the round settled with a no-quorum entry undecided');
    assert.notEqual(nothing.state, 'ACCEPTED');
    const pending = await (await fetch(`http://127.0.0.1:${w.a.port}/standing?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`)).json();
    assert.equal(pending.windowCloseMs, String(win.ownCloseMs), 'the pending line does not say the later time');
    skipTo(Number(win.ownFinalAfterMs) + 50);
    const got = await untilSettled(w, 60000);
    const facts = { first: first[0].state, end: [w.a, w.b].map((d) => stateAt(d, w, x.eid).state), settled: got.state, settlements: w.port.settlements.length,
      claims: w.port.settlements[0] ? w.port.settlements[0].claims.filter((c) => c.kind !== 'fee').map((c) => key(c.outpoint) === key(lost.outpoint) ? 'loser' : 'other') : null,
      paid: w.port.settlements[0] ? w.port.settlements[0].payouts.filter((p) => p.kind !== 'signer node' && p.kind !== 'donation key').map((p) => String(p.msat)) : null,
      rescuedPaid: [...w.port.payouts.values()].filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(x.entry.playerPubkey))).map((p) => String(p.msat)),
      winnerPaid: [...w.port.payouts.values()].filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(won.entry.playerPubkey))).map((p) => String(p.msat)) };
    console.log('  FACTS (rescued winner):', JSON.stringify(facts));
    assert.deepEqual(facts.end, ['FINAL', 'FINAL']);
    assert.equal(got.state, 'ACCEPTED', JSON.stringify(got));
    assert.equal(w.port.settlements.length, 1);
    assert.deepEqual(facts.claims, ['loser']);
    assert.equal(facts.rescuedPaid.length, 1, 'the rescued winner has no share of the pool');
    assert.equal(facts.winnerPaid.length, 0, 'the other qualifier took the rank the rescued winner holds');
  } finally { await w.close(); }
});

test('a no-quorum entry nobody rescues is VOID at end + 1205 s; the round settles then, without it, and its lock is left for its player', { timeout: 115000 }, async () => {
  const w = await lockRound(OPTS);
  try {
    const { won, lost, x, honest } = await splitRound(w);
    const win = windowsOf(w.c);
    skipTo(Number(win.finalAfterMs) + 50);
    // SEAT B HAS SIGNED ITS RE-RUN ONE SCORE APART (the test's bytes, in both stores): 2 of 2 cannot agree on one run
    const r = { contradictedRunId: NO_RUN, signedAtMs: BigInt(w.b.round.now()), result: { ...honest, score: (honest.score + 5) >>> 0, nodePubkey: w.b.round.pubkey } };
    const bytes = joinSignedRerun(encodeRerunResult(r), schnorr.sign(rerunResultId(r), w.b.round.identity.secret));
    for (const d of [w.a, w.b]) d.round.putRerun(w.rid, x.eid, w.b.round.pubkey, bytes);
    await wait(1500);
    assert.equal(w.port.settlements.length, 0, 'the round settled with a no-quorum entry undecided');
    skipTo(Number(win.rerunDeadlineMs) + 50);
    const got = await untilSettled(w, 60000);
    const claims = (w.port.settlements[0] && w.port.settlements[0].claims || []).filter((c) => c.kind !== 'fee').map((c) => key(c.outpoint));
    const facts = { end: [w.a, w.b].map((d) => stateAt(d, w, x.eid).state), written: [w.a, w.b].map((d) => (d.round.noQuorum(x.eid) || {}).outcome), settled: got.state,
      lockHeld: w.port.locks.has(key(x.outpoint)), slash: w.a.round.slashProofs(w.rid, x.eid).length };
    console.log('  FACTS (nobody rescues it):', JSON.stringify(facts));
    assert.deepEqual(facts.end, ['VOID', 'VOID']);
    assert.deepEqual(facts.written, ['VOID', 'VOID']);
    assert.equal(got.state, 'ACCEPTED', JSON.stringify(got));
    assert.deepEqual(claims, [key(lost.outpoint)]);
    assert.equal(facts.lockHeld, true);
    assert.equal(facts.slash, 0);
    assert.ok([...w.port.payouts.values()].some((p) => toHex(p.payoutPk) === toHex(refundKeyOf(won.entry.playerPubkey))), 'the winner was not paid');
  } finally { await w.close(); }
});
