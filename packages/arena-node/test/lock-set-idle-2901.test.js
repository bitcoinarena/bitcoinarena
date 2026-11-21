// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2901 (measured 2026-11-16: 8 seats' main threads at ~100 %, ~80 lock-set rounds a minute per seat, nearly all with 0 entries): a round a seat
// holds no handout and no entry for is not stepped by its lock-set timer; a seat that holds one steps it and its peers take part when it asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };

test('#2901: a round nobody entered gets no lock-set work at any seat; its GET /lock-set still answers', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    skipTo(Number(w.c.entryCloseMs) + 10);
    await wait(LOCK_SET_WINDOW_MS + 600);
    assert.deepEqual(w.nodes.map((d) => d.lockSets.touched(w.rid)), w.nodes.map(() => false), 'a seat stepped a round nobody entered');
    const s = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/lock-set?round=${toHex(w.rid)}`)).json();
    assert.equal(s.required, true); assert.equal(s.certificate, null);
  } finally { await w.close(); }
});

// a round WITH entries is stepped and certified as before: h2h-lock-set-2561.test.js (5-of-7 honest path, 2-of-2) runs on this code
