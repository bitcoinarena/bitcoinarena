// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 bypass of #1479 ("one entry per session key"): ONE PLAYER STANDS WITH ROCK, PAPER AND SCISSORS UNDER THREE FRESH SESSION KEYS
// AND PAYS ONLY FOR THE WINNER. The #1479 rule binds a session key, and a client makes a fresh one for every entry, so three keys cost nothing.
// In a paying head-to-head round the /entry door counts only lock-backed entries (#1437), so all three lockless entries are taken. The /lock
// door still takes a stake lock up to entry close + ENTRY_CLOSE_GRACE_MS (15 s, kanban #1260), while reveals stand from entry close on and
// GET /reveals is public: the attacker reads the honest player's move after the close and locks only the entry that beats it.
// Adapted to 1.9 by #2536 (kanban #1789): 1.9 serves no move of a paying head-to-head round before close + H2H_REVEAL_HOLD_MS (#1822),
// so the attacker reads the honest move only then and locks after it. Two seats, as the card has it; seat 0 plants the lock with the
// time it really took it (no door). The backdated signed-word variant in 2-of-2 is #2199 / #2483 (open for a ruling); three seats: sup-1788.
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
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { H2H_REVEAL_HOLD_MS } from '../src/server.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('#1789 (1.9, two seats) #1598 refute 2: ONE seat (a pre-#1598 build with the 15 s grace, or a seat that keeps no door) takes the lock after the reveal; every fixed seat pulls it via GET /order-locks', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, honest, ROCK, hs);
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 100);   // 1.9 serves no move before the close + the hold (#1822)
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[1].port}/reveals?round=${toHex(w.rid)}`)).json();
    const seen = pub.reveals.find((r) => r.entry === toHex(honest.eid)).move;
    const win = BEATS[seen];
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 600);
    const atFixed = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(moves[win].played.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(moves[win].played.fields)) });
      atFixed.push(`${r.status} ${(await r.text()).slice(0, 60)}`);
    }
    // seat 0 runs the build before #1598 (a seat roll is one by one) or keeps no door at all: it takes the lock 1 s after the close, inside the grace it has
    const p = moves[win].played, e = decodeEntryContract(new Uint8Array(w.nodes[0].round.entry(p.eid)));
    w.nodes[0].round.putStakeLock({ entryId: p.eid, roundId: w.rid, outpoint: e.stakeLockOutpoint, fields: lockFieldsToJson(p.fields), contractId: String(await w.port.contractId(p.fields)) });
    await reveal(w, p, win, moves[win].salt);
    await closeRound(w);
    const settled = await untilSettled(w, 20000);
    const got = { honest: results(w, honest.eid), attacker: results(w, p.eid) };
    const heldAt = w.nodes.map((d) => !!d.round.stakeLock(p.eid));
    console.log('  FACTS (#1598 refute 2):', JSON.stringify({ seen, lockedMove: win, atFixed, heldAt, results: got, state: settled && settled.state }));
    assert.equal(heldAt[1], false, `a fixed seat took a stake lock new to it after the close and after a reveal, pulled from one peer: ${JSON.stringify({ atFixed, heldAt, got })}`);
    assert.equal(got.attacker.every((per) => per.includes('DELIVERED 2')), false, `the attacker won with the lock chosen after the reveal: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
