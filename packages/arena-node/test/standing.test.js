// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PENDING LINE'S FIGURE (WINDOW-10-SPEC, 2026-10-01, §24): GET /standing?entry= - this entry's state, its row
// of the payout table over the results signed so far, and the window (the round's end, and 600 s after). Measured on two
// signer nodes and the fake lock port: a winner and a loser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { WINNER, LOSER, wait, sevenSignerNodes, WINDOW_MS } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';

const standingAt = async (d, eid) => (await fetch(`http://127.0.0.1:${d.port}/standing?entry=${toHex(eid)}`)).json();

test('the standing: before any result, no pending figure; once the results are signed, the winner\'s row is its stake back and the loser\'s, the loser\'s 0, and the window closes at round end + 600 s', async () => {
  const w = await lockRound({ port: lockPort() });
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    const early = await standingAt(w.a, won.eid);
    console.log('  FACTS (early):', JSON.stringify(early));
    assert.equal(early.pendingMsat, null, 'a pending figure before any result was signed');
    await closeRound(w);
    let s = null;
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      s = await standingAt(w.a, won.eid);
      if (s.pendingMsat !== null && !s.provisional) break;
    }
    const l = await standingAt(w.a, lost.eid);
    const atB = await standingAt(w.b, won.eid);
    console.log('  FACTS (signed):', JSON.stringify({ winner: s, loser: { state: l.state, pendingMsat: l.pendingMsat }, atB: atB.pendingMsat }));
    assert.ok(['PROVISIONALLY_FINAL', 'FINAL'].includes(s.state), `the winner's result is not signed: ${s.state}`);
    assert.equal(BigInt(s.pendingMsat), netStakeMsat(won.entry) + netStakeMsat(lost.entry), 'the winner\'s pending is not its stake back and the loser\'s');
    assert.equal(s.kind, 'payout');
    assert.equal(s.provisional, false, 'both results are in, yet the figure is marked provisional');
    assert.equal(l.pendingMsat, '0', 'the loser has something pending');
    assert.equal(atB.pendingMsat, s.pendingMsat, 'the other signer node says another figure');
    const end = roundEndMs(w.c);
    assert.equal(BigInt(s.windowOpenMs), end, 'the window does not open at the round\'s end');
    assert.equal(BigInt(s.windowCloseMs) - BigInt(s.windowOpenMs), 600000n, 'the window is not exactly 600 s');
    assert.equal((await fetch(`http://127.0.0.1:${w.a.port}/standing?entry=${'00'.repeat(32)}`)).status, 404);
  } finally { await w.close(); }
});

// SETTLED WITHOUT FINAL (2026-10-01): a result still PROVISIONALLY_FINAL past end + 605 s, in a round whose
// settlement this seat holds ACCEPTED and which pays the entry's share, owes nothing: no pending amount, the state left
// PROVISIONALLY_FINAL. Made here as testnet4's rounds of the day before are: settled, and no FINAL signature held - the
// seat's FINAL signatures removed after the settlement was accepted. Then that same round with its settlement not yet
// accepted (SUBMITTING): the pending amount shows.
test('a round settled and accepted, with no FINAL signatures, gives no pending amount; the same round before its settlement is accepted, or not yet settled, still shows it', async () => {
  const w = await lockRound({ port: lockPort() });
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    let held = null;
    for (const stop = Date.now() + 15000; Date.now() < stop && !(held = w.a.round.lockSettlement(w.rid)); await wait(250));
    for (const stop = Date.now() + 15000; Date.now() < stop && (!held || held.state !== 'ACCEPTED'); await wait(250)) held = w.a.round.lockSettlement(w.rid);
    assert.equal(held && held.state, 'ACCEPTED', 'signer node a holds no ACCEPTED settlement');
    // NO FINAL SIGNATURE HELD (as on testnet4's older rounds): cleared before every reading - the live seats' watches
    // would sign it again between readings.
    const noFinal = () => w.a.round.db.prepare('DELETE FROM final_sigs WHERE round_id = ?').run(w.rid);
    noFinal();
    const accepted = { winner: await standingAt(w.a, won.eid), loser: await standingAt(w.a, lost.eid) };
    w.a.round.db.prepare("UPDATE lock_settlements SET state = 'SUBMITTING' WHERE round_id = ?").run(Buffer.from(w.rid));
    noFinal();
    const before = { winner: await standingAt(w.a, won.eid), loser: await standingAt(w.a, lost.eid) };
    // AND THE SAME ROUND AS ONE NOT YET SETTLED: no settlement record at all on this seat - the winner's amount shows.
    const kept = ['lock_settlements', 'lock_settlement_moves', 'lock_settlement_shares'].map((t) =>
      [t, w.a.round.db.prepare(`SELECT * FROM ${t} WHERE round_id = ?`).all(Buffer.from(w.rid))]);
    for (const [t] of kept) w.a.round.db.prepare(`DELETE FROM ${t} WHERE round_id = ?`).run(Buffer.from(w.rid));
    noFinal();
    const unsettled = { winner: await standingAt(w.a, won.eid), loser: await standingAt(w.a, lost.eid) };
    for (const [t, rows] of kept) for (const r of rows) {
      const cols = Object.keys(r);
      w.a.round.db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => r[c]));
    }
    w.a.round.db.prepare("UPDATE lock_settlements SET state = 'ACCEPTED' WHERE round_id = ?").run(Buffer.from(w.rid));
    assert.equal(unsettled.winner.state, 'PROVISIONALLY_FINAL');
    assert.equal(BigInt(unsettled.winner.pendingMsat), netStakeMsat(won.entry) + netStakeMsat(lost.entry), 'not yet settled, the winner shows no pending amount');
    noFinal();
    assert.equal((await standingAt(w.a, won.eid)).pendingMsat, null, 'the settlement put back, the line did not go again');
    const brief = (x) => ({ state: x.state, pendingMsat: x.pendingMsat, settled: !!x.settled, why: String(x.why).slice(0, 110) });
    console.log('  FACTS (settled without FINAL):', JSON.stringify({ accepted: { winner: brief(accepted.winner), loser: brief(accepted.loser) },
      before: { winner: brief(before.winner), loser: brief(before.loser) }, unsettled: { winner: brief(unsettled.winner), loser: brief(unsettled.loser) } }));
    for (const who of ['winner', 'loser']) {
      assert.equal(accepted[who].state, 'PROVISIONALLY_FINAL', `${who}: the state moved`);
      assert.equal(accepted[who].pendingMsat, null, `${who}: a pending amount for a round settled and accepted`);
      assert.match(accepted[who].why, new RegExp(`the round's settlement ${held.txid} is ACCEPTED by the federation and pays this entry's share`));
      assert.equal(before[who].state, 'PROVISIONALLY_FINAL');
    }
    assert.equal(BigInt(before.winner.pendingMsat), netStakeMsat(won.entry) + netStakeMsat(lost.entry), 'before acceptance the winner shows no pending amount');
    assert.equal(before.loser.pendingMsat, '0');
  } finally { await w.close(); }
});

// AND A LIVE ROUND: past end + 605 s, PROVISIONALLY_FINAL, not yet settled - its row is still reported (this fixture's
// runs lose, so the row is 0; a winner's amount, unsettled, is measured in the test above).
test('a live round past end + 605 s and not yet settled still shows its pending amount', async () => {
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });
  try {
    w.sign('agrees', () => ({}));
    const eid = w.runs.agrees.eid;
    skipTo(Number(windowsOf(w.contract).finalAfterMs) + 1000);
    const s = await (await fetch(`http://127.0.0.1:${w.holder.port}/standing?entry=${toHex(eid)}`)).json();
    console.log('  FACTS (live, unsettled):', JSON.stringify({ state: s.state, pendingMsat: s.pendingMsat, settled: !!s.settled, held: !!w.holder.round.lockSettlement(w.rid) }));
    assert.equal(s.state, 'PROVISIONALLY_FINAL', s.why);
    assert.equal(w.holder.round.lockSettlement(w.rid), null, 'the round is settled: not the case the test names');
    assert.notEqual(s.pendingMsat, null, 'a live unsettled round past end + 605 s lost its pending amount');
    assert.equal(s.kind, 'payout', 'the entry\'s row is not reported');
    assert.equal(s.settled, undefined);
  } finally { await w.close(); }
});
