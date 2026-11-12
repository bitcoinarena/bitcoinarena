// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit of #1485: the seat-to-seat entry relay (entry-relay.js, #1068) posts the entry's handout to a peer
// 0.7-1.2 s after the first seat took the entry - through the same POST /handout, now refused inside the lead. An entry
// a client posted in time (2.6 s before the close, handout and lock taken) never reaches the seat the client missed:
// with 2 seats (threshold 2) it can never stand, and its lock - already made - is spent for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, entryCloseMs: 6000n };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('wf1489 bypass-late-lock 1 (kanban #1595): an entry handed on by the seat relay inside the lead reaches the peer (its handout held by a round peer is taken)', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 2000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const close = Number(w.c.entryCloseMs);
    console.log('  window:', JSON.stringify({ committeeToClose: close - Number(w.c.committeeTimeMs), leftNow: close - testNow() }));
    skipTo(close - 2600);
    assert.ok(testNow() >= Number(w.c.committeeTimeMs), 'entries open');
    const b = await lockAndPlay(w, mk(2), { hidden: { move: 1, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, unreached: [1] });
    const seat = w.nodes[1];
    const tookAt = close - testNow();
    for (const until = Date.now() + 2300; Date.now() < until && !seat.round.entry(b.eid);) await new Promise((r) => setTimeout(r, 50));
    console.log('  FACTS (wf1489-2):', JSON.stringify({ leftWhenSeat0Took: tookAt, leftNow: close - testNow(), seat1HoldsEntry: !!seat.round.entry(b.eid) }));
    assert.ok(seat.round.entry(b.eid), 'the seat the client did not reach never got the entry from its peer before the close (the relayed handout is refused inside the lead)');
  } finally { await w.close(); }
});
