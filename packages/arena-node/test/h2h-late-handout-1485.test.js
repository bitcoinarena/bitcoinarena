// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO HANDOUT FOR A HEAD-TO-HEAD ROUND THAT CLOSES BEFORE ITS ORDER CAN LAND (kanban #1485, feedback #010 2026-11-11, round 77bd9609; Daniel: "Er sollte
// keine fees entgegen nehmen wenn die order nicht angenommen wird"): a seat took a handout 1.8 s after the close, the page locked the stake and every seat
// refused the entry. A handout with less than 2 s before a head-to-head close is refused now, so the page locks nothing; earlier it is taken as before.
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
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });
const enter = async (w, who) => {
  try { await lockAndPlay(w, who, { session: who.session, hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); return 'taken'; }
  catch (e) { return String(e.message).split('\n').join(' ').slice(0, 300); }
};

test('#1485 a head-to-head handout inside the lead before the close is refused (nothing to lock); before the lead it is taken (lead 1 s here, the fixture window is 1.5 s; 2 s live)', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 1000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const close = Number(w.c.entryCloseMs);
    skipTo(Number(w.c.committeeTimeMs) + 20);
    assert.ok(close - testNow() > 1000, `the window leaves ${close - testNow()} ms`);
    const early = await enter(w, mk(1));
    skipTo(close - 500);
    const late = await enter(w, mk(2));
    console.log('  FACTS (#1485):', JSON.stringify({ early, late }));
    assert.equal(early, 'taken');
    assert.match(late, /409/, `a handout 1 s before a head-to-head close was taken: ${late}`);
    assert.equal(w.nodes[0].round.entriesOf(w.rid).length, 1, 'only the timely entry stands');
  } finally { await w.close(); }
});
