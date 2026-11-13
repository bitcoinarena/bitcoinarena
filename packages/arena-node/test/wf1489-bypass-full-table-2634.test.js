// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BYPASS OF #1485 (kanban #1489): "no handout, so no lock, for a head-to-head order the seats will refuse" holds only for the close. A paid
// head-to-head round that already seats its two players on locks takes a third player's handout (201) and refuses its entry (400 "already
// seats ...") or its lock at /lock - by then the page has made the federation lock, whose developers' and
// reserves' parts stay spent. The handout of an order that can take no seat should be refused, as a late one is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

test('#1489 bypass of #1485: a full paid head-to-head round takes a third handout, so the page locks and the seats refuse the entry', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 1000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    await lockAndPlay(w, mk(1), { hidden: { move: 0, salt: salt() }, noMarks: true });
    await lockAndPlay(w, mk(2), { hidden: { move: 1, salt: salt() }, noMarks: true });
    // the third player: well before the close (the #1485 lead holds), every step's answer recorded
    const said = [];
    globalThis.fetch = async (url, o) => { const r = await realFetch(url, o); const p = new URL(String(url)).pathname;
      if (['/handout', '/entry', '/lock'].includes(p)) said.push(`${p} ${r.status}${r.status >= 300 ? ' ' + (await r.clone().text()).slice(0, 90) : ''}`); return r; };
    let third;
    try { await lockAndPlay(w, mk(3), { hidden: { move: 2, salt: salt() }, noMarks: true }); third = 'taken'; } catch (e) { third = String(e.message).split('\n')[0].slice(0, 160); }
    globalThis.fetch = realFetch;
    console.log('  FACTS (#1489-1):', JSON.stringify({ leftMs: Number(w.c.entryCloseMs) - testNow(), third, said }));
    assert.notEqual(third, 'taken', 'a third player was seated in a two-player round');
    const handouts = said.filter((x) => x.startsWith('/handout'));
    assert.ok(handouts.length && handouts.every((x) => / 409/.test(x)),
      `the seats took the handout of an order no seat can take - the page locks its stake and the seats refuse its entry: ${JSON.stringify(said)}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
