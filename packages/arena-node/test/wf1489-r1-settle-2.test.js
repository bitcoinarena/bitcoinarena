// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-settle-2: GET /settle-sends?late= MAKES NOTHING FOR A LATE SETTLEMENT THE SEAT DOES NOT HOLD.
// The door is public. For any 32-byte round id (a round this seat does not hold passes seriesRefusalOfRound) and any
// `late` value (not even checked to be 64 hex), settlement.js lateWinningsFor builds a new WinningsSend - three Maps and a
// store scope - keeps it in `lateSenders` for good (no bound, no eviction), and the door signs its answer. A stranger
// loops random ids and the seat's heap grows without end. Safe: no late sender is kept for a late settlement this seat
// does not hold, and the map stays bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound } from './lock-round-fixture.js';
import { testNow } from './test-clock.js';

test('wf1489 r1-settle-2: a stranger\'s GET /settle-sends?late= for unheld settlements keeps no late sender', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const at = `http://127.0.0.1:${w.a.port}`;
    const N = 300;
    const statuses = new Map();
    for (let i = 0; i < N; i++) {
      const rid = randomBytes(32).toString('hex');
      const late = randomBytes(32).toString('hex');
      const r = await fetch(`${at}/settle-sends?round=${rid}&late=${late}`);
      await r.arrayBuffer();
      statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
    }
    // and a `late` that is no entry id at all
    for (let i = 0; i < 20; i++) { const r = await fetch(`${at}/settle-sends?round=${randomBytes(32).toString('hex')}&late=zz${i}`); await r.arrayBuffer(); statuses.set(r.status, (statuses.get(r.status) || 0) + 1); }
    const kept = w.a.settlements.lateSenders ? w.a.settlements.lateSenders.size : 0;
    console.log('  FACTS:', JSON.stringify({ asked: N + 20, statuses: Object.fromEntries(statuses), lateSendersKept: kept }));
    assert.equal(kept, 0, `${kept} late senders kept for ${N + 20} late settlements this seat does not hold - one per stranger request, never freed`);
  } finally { await w.close(); }
});
