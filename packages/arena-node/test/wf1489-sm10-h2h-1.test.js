// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 sm10-find-h2h 1: A LEAVING SEAT IS TOLD IT IS FREE OF A HEAD-TO-HEAD ROUND BEFORE IT HAS SIGNED IT.
// owner-leave.js leaveStatus frees a round at end + W. But a seat signs FINAL only at end + W + T (window.js finalAfterMs,
// §13A: window close + 5 s), and a head-to-head seat still learning who is in the round (server.js membersKnown) may sign its
// results as late as that same finalAfterMs. With the head-to-head window of 60 s (#1398) a free round's seat is reported
// free 5 s before it signs anything final: the owner stops it, its FINAL signature (and maybe its result) never comes.
// Safe behaviour: a round is owed until its finalAfterMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveStatus } from '../src/owner-leave.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { OBJECTION_WINDOW_H2H_MS } from '../../arena-protocol/src/constants.js';

test('a free head-to-head round is still owed between its window close and the FINAL signing time', () => {
  const entryCloseMs = 1_000_000n;
  // a head-to-head round's end is its reveal deadline; windowsOf only needs the contract's end and W
  const contract = { entryCloseMs, blockTicks: 600, startDeadlineTicks: 300, objectionWindowMs: OBJECTION_WINDOW_H2H_MS };
  let win;
  try { win = windowsOf(contract); } catch (e) { win = null; }
  const endMs = win ? Number(win.openMs) : Number(entryCloseMs) + 30000;
  const finalAfterMs = win ? Number(win.finalAfterMs) : endMs + Number(OBJECTION_WINDOW_H2H_MS) + 5000;
  const nowMs = endMs + Number(OBJECTION_WINDOW_H2H_MS) + 1000;   // past the window, 4 s before this seat signs FINAL
  assert.ok(nowMs < finalAfterMs);
  const s = leaveStatus({ rounds: [{ id: 'aa', endMs, objectionWindowMs: Number(OBJECTION_WINDOW_H2H_MS), assigned: true, paying: false, entries: 2, settlementAccepted: false }],
    nowMs, leavingAtMs: 1 });
  console.log('  FACTS:', JSON.stringify({ endMs, finalAfterMs, nowMs, freeNow: s.freeNow, freeAtMs: s.freeAtMs, owed: s.owed }));
  assert.equal(s.freeNow, false, `reported free at ${nowMs}, before the seat signs FINAL at ${finalAfterMs}`);
  assert.ok(s.freeAtMs === null || s.freeAtMs >= finalAfterMs, `freeAtMs ${s.freeAtMs} is before finalAfterMs ${finalAfterMs}`);
});
