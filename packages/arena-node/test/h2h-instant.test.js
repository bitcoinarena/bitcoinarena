// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY MOVE IN: DECIDED NOW (2026-10-09 playtest: "after the reveal it still takes 10-15 s until the result stands -
// it has to be more instant"). Seats that close their own rounds (closeAtEnd) close a head-to-head round the moment each holds
// a reveal for every entry - not at its reveal deadline; a round short of a reveal still waits for that deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, openLockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
let k = 0x70;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const reveal = (r, played, move, salt) => Promise.all(r.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((x) => x.status)));
const decided = (r) => Promise.all(r.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(r.rid)}`).then((x) => x.json())
  .then((j) => (j.players || []).filter((p) => p.outcome && p.signedBy > 0).length)));

test('both moves revealed: both seats decide at once, long before the reveal deadline; one move missing: nothing until it', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    const play = async (r, both) => {
      skipTo(Number(r.c.committeeTimeMs) + 20);
      const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
      const a = await lockAndPlay(r, player(), { hidden: { move: 0, salt: sa }, noMarks: true });
      const b = await lockAndPlay(r, player(), { hidden: { move: 2, salt: sb }, noMarks: true });
      skipTo(Number(r.c.entryCloseMs) + 500);
      const t0 = Date.now();
      await reveal(r, a, 0, sa);
      if (both) await reveal(r, b, 2, sb);
      let n = [0, 0];
      for (let i = 0; i < 40 && !n.every((x) => x === 2); i++) { await wait(100); n = await decided(r); }
      return { decidedPerSeat: n, ms: Date.now() - t0, deadlineInMs: Number(roundEndMs(r.c)) - testNow() };
    };
    const one = await play(w, false);
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const two = await play(w2, true);
    console.log('  INSTANT:', JSON.stringify({ oneRevealed: one, bothRevealed: two }));
    assert.deepEqual(one.decidedPerSeat, [0, 0], 'a move is missing: the seats wait for the reveal deadline');
    assert.deepEqual(two.decidedPerSeat, [2, 2], 'both moves in: each seat signed both results');
    assert.ok(two.ms < 3000, `decided ${two.ms} ms after the reveals`);
    assert.ok(two.deadlineInMs > 5000, 'and well before the reveal deadline');
  } finally { await w.close(); }
});
