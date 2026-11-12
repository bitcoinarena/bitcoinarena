// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 bypass of #1479 ("one entry per session key"): ONE PLAYER STANDS WITH ROCK, PAPER AND SCISSORS UNDER THREE FRESH SESSION KEYS
// AND PAYS ONLY FOR THE WINNER. The #1479 rule binds a session key, and a client makes a fresh one for every entry, so three keys cost nothing.
// In a paying head-to-head round the /entry door counts only lock-backed entries (#1437), so all three lockless entries are taken. The /lock
// door still takes a stake lock up to entry close + ENTRY_CLOSE_GRACE_MS (15 s, kanban #1260), while reveals stand from entry close on and
// GET /reveals is public: the attacker reads the honest player's move after the close and locks only the entry that beats it.
// Safe behaviour: the winning move is not chosen after the opponent's reveal - no stake lock seats an entry once a reveal of the round is out
// (or a head-to-head entry is seated only with its lock before entry close), and the honest player is not beaten.
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
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('#1489 bypass #1479: three fresh session keys stand rock, paper and scissors; only the one that beats the public reveal is locked', async () => {
  // every live seat runs with ENTRY_CLOSE_GRACE_MS (main.js); the fixture's default is none
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player: entry and both locks at every seat, rock
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    // the attacker: three entries, each under a fresh session key and a fresh round player key (both are the page's own per-entry keys)
    // - fee lock handed, stake lock held back
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      try { moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s }; }
      catch (e) { moves[move] = { refused: String(e.message).split('\n')[0].slice(0, 200) }; }
    }
    const taken = Object.fromEntries(Object.entries(moves).map(([m, v]) => [m, v.refused || 'taken']));
    // entry close: the honest page reveals; GET /reveals is public from the close + H2H_REVEAL_HOLD_MS (1750 ms, kanban #1822)
    skipTo(Number(w.c.entryCloseMs) + 1800);
    await reveal(w, honest, ROCK, hs);
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const seen = pub.reveals.find((r) => r.entry === toHex(honest.eid)).move;
    const win = BEATS[seen];
    // 2.5 s after the close (inside the 15 s grace): the stake lock of the winning entry only
    skipTo(Number(w.c.entryCloseMs) + 2500);
    const lockAnswers = [];
    if (moves[win].played) {
      for (const d of w.nodes) {
        const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(moves[win].played.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(moves[win].played.fields)) });
        lockAnswers.push(`${r.status} ${(await r.text()).slice(0, 120)}`);
      }
      await reveal(w, moves[win].played, win, moves[win].salt);
    }
    await closeRound(w);
    const settled = await untilSettled(w, 20000);
    const got = { honest: results(w, honest.eid), attacker: moves[win].played ? results(w, moves[win].played.eid) : null };
    console.log('  FACTS (#1489 bypass-session-key-1):', JSON.stringify({ taken, seen, lockedMove: win, lockAnswers, results: got, state: settled && settled.state }));
    const attackerWon = !!moves[win].played && lockAnswers.every((a) => a.startsWith('201')) && got.attacker.every((per) => per.includes('DELIVERED 2'));
    assert.equal(attackerWon, false, `one player stood three times and locked only the move that beat the honest player's public reveal: ${JSON.stringify({ taken, lockAnswers, got })}`);
  } finally { await w.close(); }
});
