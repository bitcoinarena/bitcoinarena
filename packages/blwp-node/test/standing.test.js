// THE PENDING LINE'S FIGURE (WINDOW-10-SPEC, the owner 2026-10-01, §24): GET /standing?entry= - this entry's state, its row
// of the payout table over the results signed so far, and the window (the round's end, and 600 s after). Measured on two
// signer nodes and the fake lock port: a winner and a loser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, LOSER, wait } from './window-fixture.js';
import { toHex } from '../../protocol/src/hash.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';

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
