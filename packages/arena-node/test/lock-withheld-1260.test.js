// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1260 (audit 4 #1257 PLAYER-1, seats-2): #1216 handed every game's entry and lock on to the other seats - unless the request carried
// x-arena-relayed, a plain header any client can send - and closed the ENTRY door only. A player posted his locks to some seats with that header
// (nothing handed on), played, and posted them to the rest only once the run had won (FINAL, paid); a losing run was VOID there (the stake back).
// Now every copy a seat takes is handed on, header or not, and a lock new to a seat after the entry close and its grace is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const until = async (ok, ms = 6000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return ok(); };
const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1260 a lock a client posts to one seat with x-arena-relayed is still handed on to the seat it was withheld from', async () => {
  const w = await lockRound({});
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const a = await lockAndPlay(w, player('withholder', 0x71), { only: [0], lockHeaders: { 'x-arena-relayed': '1' }, noMarks: true });
    const t0 = Date.now();
    const other = w.nodes[1].round;
    const entry = !!other.entry(a.eid);
    const lock = await until(() => !!other.stakeLock(a.eid));
    const fee = await until(() => !!(other.feeLock && other.feeLock(a.eid)), 2000);
    console.log('  FACTS #1260 relay:', JSON.stringify({ lockPosted: 'seat 0 only, with the relay header', atSeat1: { entry, lock, fee, ms: Date.now() - t0 } }));
    assert.equal(entry, true, 'the fixture: the entry is at both seats');
    assert.equal(lock, true, 'the stake lock did not reach the seat it was withheld from: the client\'s header switched the relay off');
    assert.equal(fee, true, 'the fee lock did not reach the seat it was withheld from');
  } finally { await w.close(); }
});

test('#1260 a lock new to a seat after the entry close and its grace is refused; a lock the seat holds already is answered as before', async () => {
  const w = await lockRound({ serveOpts: { entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, endMs: testNow() + 600000 });
  assert.ok(Number(w.c.entryCloseMs) > testNow(), 'the round\'s entry close is not ahead');
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // before the close: one player's entry everywhere and its locks nowhere (held back), another's entry and locks everywhere
    const held = await lockAndPlay(w, player('held back', 0x72), { only: [], noMarks: true });
    const fair = await lockAndPlay(w, player('fair', 0x73), { noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + Number(ENTRY_CLOSE_GRACE_MS) + 5000);
    const base = `http://127.0.0.1:${w.nodes[0].port}`;
    const post = async (p) => { const r = await fetch(`${base}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) }); return { status: r.status, why: (await r.text()).slice(0, 400) }; };
    const late = await post(held);
    const again = await post(fair);
    console.log('  FACTS #1260 door:', JSON.stringify({ graceMs: Number(ENTRY_CLOSE_GRACE_MS), heldBackLockAfterClose: late, heldLockPostedAgain: again.status, stakeSeenAfter: !!w.nodes[0].round.stakeSeen(held.eid) }));
    assert.equal(late.status, 409, late.why);
    assert.match(late.why, /new to this seat is not taken/);
    assert.equal(w.nodes[0].round.stakeSeen(held.eid), null, 'the late lock was counted');
    assert.equal(again.status, 201, again.why);
  } finally { await w.close(); }
});
