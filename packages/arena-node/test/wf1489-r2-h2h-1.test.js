// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (h2h-1): A STAKE LOCK WITH NO FEE LOCK TAKES A SEAT AND IS PLAYED, BUT ITS STAKE IS NEVER AT RISK.
// seatedEntriesOf seats an entry whose stake lock is verified and still waits for its fee lock (stakeLock, not stakeSeen), so the head-to-head
// decide plays it against the honest player. The settlement counts only stakeSeen entries: the griefer's lost stake is not in the table,
// is never claimed and comes back to him by refund, while the honest winner gets only his own stake back. A free option for the griefer.
// SAFE: in a round whose gate mints fee locks, a seated entry that loses has its stake claimed for the winner - or it takes no seat at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('a stake lock handed without its fee lock either takes no seat, or its lost stake is claimed for the winner', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sg = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // the griefer: its entry everywhere (naming a fee lock outpoint the federation holds), its stake lock handed, its fee lock never
    const g = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: sg }, noMarks: true, only: [] });
    const lockAns = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(g.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(g.fields)) });
      lockAns.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
    }
    const seatedG = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).some((x) => toHex(x.entryId) === toHex(g.eid)));
    const seenG = w.nodes.map((d) => !!d.round.stakeSeen(g.eid));
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, g, SCISSORS, sg);
    await closeRound(w);
    const settled = await untilSettled(w, 20000);
    const got = { a: results(w, a.eid), g: results(w, g.eid) };
    const plan = JSON.stringify(settled).slice(0, 1500);
    console.log('  FACTS (h2h-1):', JSON.stringify({ lockAns, seatedG, seenG, state: settled.state, why: settled.why, results: got }));
    console.log('  PLAN (h2h-1):', plan);
    // the griefer lost (scissors against rock). Either it was played - then its stake is claimed - or it took no seat.
    const played = got.g.some((per) => per.includes('FAILED 0'));
    if (played) {
      assert.ok(JSON.stringify(settled).includes(toHex(g.outpoint.txid)) || JSON.stringify(settled).includes(toHex(g.eid)),
        `the griefer was played and lost at the seats (${JSON.stringify(got.g)}), and its stake lock is nowhere in the round's settlement: ${plan}`);
    }
  } finally { await w.close(); }
});
