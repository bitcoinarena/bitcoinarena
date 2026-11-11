// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-h2h 1: A HEAD-TO-HEAD ENTRY WHOSE STAKE NEVER COUNTED IS PLAYED, AND THE SETTLEMENT LEAVES IT OUT.
// The seating rule (round.js seatedEntriesOf, #1437) counts an entry whose stake lock is verified and still waits for its fee lock
// ("waitsForFeeLock": no stake_seen row). The head-to-head close decides over that same set (verify.js #headToHeadClose), so such an
// entry is played and signed WIN / LOSS. The settlement takes only entries whose stake was seen (settlement.js entriesOnRecord), so it is
// not in the table: a player who hands his stake lock and withholds his fee lock is played for free - when he wins, the honest
// opponent is booked FAILED against nobody; when he loses, nothing of his is claimed.
// Invariant: an entry is played (signed DELIVERED/FAILED) only if this seat counts its stake (stake_seen) - otherwise VOID.
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
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const SLACK_MS = 25000;
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return `${p.outcome} ${p.score}`;
}));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));

test('#1489 sm2-h2h-1: an entry with a stake lock and no fee lock is not played in a paying head-to-head round', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player: entry, stake lock and fee lock at every seat - rock
    const sa = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // the other: its entry at every seat, then ONLY its stake lock (its fee lock exists in the federation and is never handed) - paper
    const sb = salt();
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [] });
    const lockAnswers = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(b.fields)) });
      lockAnswers.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
    }
    const counted = w.nodes.map((d) => ({ aSeen: !!d.round.stakeSeen(a.eid), bSeen: !!d.round.stakeSeen(b.eid), bLock: !!d.round.stakeLock(b.eid),
      seated: d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length }));
    console.log('  FACTS (sm2-h2h-1 locks):', JSON.stringify({ lockAnswers, counted }));
    for (const x of counted) assert.equal(x.bSeen, false, 'precondition: b\'s stake is not counted (it waits for its fee lock)');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb);
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    console.log('  FACTS (sm2-h2h-1 play):', JSON.stringify({ state: settled && settled.state, why: settled && settled.why, results: got }));
    // b's stake never counted at any seat: it must not be played - no DELIVERED/FAILED signed for it, and a played against nobody
    for (const per of got.b) assert.ok(per.every((x) => x === 'VOID 0'), `an entry whose stake no seat counted was played: ${JSON.stringify(got)}`);
    for (const per of got.a) assert.ok(per.every((x) => x !== 'FAILED 0'), `the honest player lost to an entry that is not in the settlement: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
