// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ENTRIES WITH NO LOCK TAKE NO SEAT OF A PAYING HEAD-TO-HEAD ROUND (kanban #1437, state machine audit 8 R3): the /entry door takes an entry
// before any lock is verified, and it counted every entry against the game's players - two entries with a free handout and no lock took
// both seats of a paying Rock Paper Scissors round, and every real, locked player was refused ("already seats ... 2 players"). Now only
// entries whose stake this seat saw (or whose stake lock it holds) take a seat, the round is decided between those, and a lock that would
// seat a third player is refused at /lock. A free round counts every entry, as before.
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

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
// THE ENTRIES CLOSE ~25 s FROM NOW (not the fixture's 4 s): five entries and their locks on a busy host
const SLACK_MS = 25000;
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return `${p.outcome} ${p.score}`;
}));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));

test('two lockless entries take no seat of a paying head-to-head round: two real players are seated, played and settled; a third lock is refused', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the squatters: entries (with their free handouts) at both seats, no lock handed anywhere - they both play paper
    const sq = [salt(), salt()];
    const g1 = await lockAndPlay(w, mk(1), { hidden: { move: PAPER, salt: sq[0] }, noMarks: true, only: [] });
    const g2 = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sq[1] }, noMarks: true, only: [] });
    const take = async (who, move, s) => { try { return await lockAndPlay(w, who, { hidden: { move, salt: s }, noMarks: true }); } catch (e) { return String(e.message).split('\n')[0].slice(0, 200); } };
    const sa = salt(), sb = salt();
    const a = await take(mk(3), ROCK, sa);
    const b = await take(mk(4), SCISSORS, sb);
    // a third real player: its entry is taken (two of the four entries hold no lock), its lock is not - the round seats two
    const c = await take(mk(5), ROCK, salt());
    console.log('  FACTS (#1437 seats):', JSON.stringify({ a: typeof a === 'string' ? a : 'taken', b: typeof b === 'string' ? b : 'taken', c: typeof c === 'string' ? c : 'taken' }));
    assert.equal(typeof a, 'object', `a real, locked player was refused: ${a}`);
    assert.equal(typeof b, 'object', `a second real, locked player was refused: ${b}`);
    assert.equal(typeof c, 'string', 'a third locked player was seated in a two-player round');
    assert.match(c, /already seats/);
    skipTo(Number(w.c.entryCloseMs) + 500);
    // the squatters reveal too: paper would beat the real winner's rock if they were played
    await reveal(w, g1, PAPER, sq[0]); await reveal(w, g2, PAPER, sq[1]);
    await reveal(w, a, ROCK, sa); await reveal(w, b, SCISSORS, sb);
    await closeRound(w);
    const settled = await untilSettled(w);
    const got = { a: results(w, a.eid), b: results(w, b.eid), g1: results(w, g1.eid), g2: results(w, g2.eid) };
    console.log('  FACTS (#1437 play):', JSON.stringify({ state: settled.state, why: settled.why, results: got }));
    for (const per of got.a) assert.deepEqual([...new Set(per)], ['DELIVERED 2'], JSON.stringify(got));
    for (const per of got.b) assert.deepEqual([...new Set(per)], ['FAILED 0'], JSON.stringify(got));
    for (const per of [...got.g1, ...got.g2]) assert.ok(per.every((x) => x === 'VOID 0'), `a lockless entry was played: ${JSON.stringify(got)}`);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
  } finally { await w.close(); }
});

test('a free head-to-head round still counts every entry: a third entry is refused at the door', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const enter = async (n) => {
      try { await lockAndPlay(w, mk(n), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [], feeLock: false }); return 'taken'; }
      catch (e) { return String(e.message).split('\n')[0].slice(0, 200); }
    };
    const got = [await enter(6), await enter(7), await enter(8)];
    console.log('  FACTS (#1437 free):', JSON.stringify(got));
    assert.deepEqual(got.slice(0, 2), ['taken', 'taken']);
    assert.match(got[2], /already seats/);
  } finally { await w.close(); }
});
