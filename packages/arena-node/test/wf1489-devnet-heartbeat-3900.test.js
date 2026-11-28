// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3900: on the 2.0 devnet every heartbeat certificate said "heard 0". The runner (round-2of2.mjs openNext) started a round 60 s
// after its committee time, a seat stored it ~4 s after that time, and its seating and heartbeat slot closed 120 s before the start - so
// the slot had closed a minute before any seat held the round, and no node could beat. A round that seats itself is now opened with its
// heartbeat minute after the moment it is posted; a round whose caller names its own times keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../tools/round-2of2.mjs';
import { heartbeatCloseMs } from '../../arena-protocol/src/heartbeat.js';
import { seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { MIN_ENTRY_WINDOW_MS, PRESENCE_VERSION } from '../../arena-protocol/src/constants.js';
import { BEAT_LEAD_MS } from '../src/heartbeat-agent.js';

// measured on the devnet (dn3902 node-2 store): rounds stored 3.4-4.4 s after their committee time
const POSTED_AFTER_COMMITTEE_MS = 5000n;
// before the fix openNext added nothing to MIN_ENTRY_WINDOW_MS: the test reads that as a lead of 0 (red there by its assertion, not its import)
const selfSeatLeadMs = runner.selfSeatLeadMs || (() => 0n);

test('#3900 a protocol-22 round the runner opens is held by the seats before its heartbeat minute and its seating close', () => {
  for (const protocolVersion of [PRESENCE_VERSION, 33, 36]) {
    const committee = 1_800_000_000_000n;
    const contract = { protocolVersion };
    const start = committee + MIN_ENTRY_WINDOW_MS + selfSeatLeadMs({ contract, kind: {}, committee });
    const c = { ...contract, startTimeMs: start };
    const posted = committee + POSTED_AFTER_COMMITTEE_MS;
    // the whole minute in which HEARTBEATs are signed lies after the round reaches the seats
    assert.ok(heartbeatCloseMs(c, 0) - BEAT_LEAD_MS > posted,
      `v${protocolVersion}: heartbeats open ${(heartbeatCloseMs(c, 0) - BEAT_LEAD_MS - posted) / 1000n} s after the post; the slot closed before any seat held the round`);
    assert.ok(seatingCloseMs(c) > posted + BEAT_LEAD_MS, `v${protocolVersion}: the seating closes too soon after the post`);
  }
});

test('#3900 rounds below 22, and rounds whose caller names their own committee time or close, keep their timing', () => {
  const committee = 1_800_000_000_000n;
  assert.equal(selfSeatLeadMs({ contract: { protocolVersion: 21 }, kind: {}, committee }), 0n);
  assert.equal(selfSeatLeadMs({ contract: { protocolVersion: 36 }, kind: { committeeAtMs: committee + 1000n }, committee }), 0n);
  assert.equal(selfSeatLeadMs({ contract: { protocolVersion: 36 }, kind: { entryCloseAtMs: committee + 900000n }, committee }), 0n);
});
