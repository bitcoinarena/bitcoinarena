// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 sm7 h2h-1: THE MEMBERSHIP WAIT IS A WAIT-FOR CYCLE (membersKnown + lookAtMembers, kanban #1071). Seven seats, 5 of 7. Both players' entries are
// members - A is held by six seats, B by five (each door refused one by the backup rule, as measured on #1068) - so the round has a quorum for both.
// But every seat short of an entry waits until five seats signed a result naming it, and signs nothing meanwhile. Seat 6 waits for A, seats 4 and 5
// wait for B: only seats 0-3 ever sign, 4 of 5, for every entry. Nobody reaches the threshold, the wait runs out at the result window, the round goes
// no-quorum and the winner is never paid.
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
const ROCK = 0, SCISSORS = 2;
const player = (name, k) => ({ name, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const signed = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
const reveal = (w, played, move, salt, seats = w.nodes) => Promise.all(seats.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.text())));
const shutDoor = (d, playerKey) => {
  const real = d.round.enter;
  d.round.enter = function (contract, ...more) {
    if (!more.length && toHex(contract.playerPubkey) === toHex(playerKey)) throw new Error('entry refused: the backup rule');
    return real.call(this, contract, ...more);
  };
};
const seatsHolding = (w, eid) => w.nodes.filter((d) => d.round.entry(eid)).length;

test('wf1489-sm7-h2h-1: two entries each a member (6 and 5 of 7 seats) - three short seats waiting on each other leave the round without a quorum', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    shutDoor(w.nodes[6], b32(0x71));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true, unreached: [6] });
    [4, 5].forEach((i) => shutDoor(w.nodes[i], b32(0x72)));
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [4, 5] });
    await new Promise((r) => setTimeout(r, 2500));                  // the relay has had its go at those doors
    assert.equal(seatsHolding(w, a.eid), 6, 'six seats hold A');
    assert.equal(seatsHolding(w, b.eid), 5, 'five seats hold B: still a member (5 of 7)');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa, w.nodes.slice(0, 6));
    await reveal(w, b, ROCK, sb, [0, 1, 2, 3, 6].map((i) => w.nodes[i]));
    await closeRound(w);
    const settled = await untilSettled(w, 30000);
    const said = w.nodes.map((d, i) => ({ seat: i, a: signed(d, w, a.eid), b: signed(d, w, b.eid), heldB: !!d.round.entry(b.eid), heldA: !!d.round.entry(a.eid) }));
    console.log('  FACTS:', JSON.stringify(said), 'settlement', settled && settled.state, settled && String(settled.why || '').slice(0, 160));
    const signersB = said.filter((s) => s.b.length).length;
    assert.ok(signersB >= 5, `only ${signersB} of 7 seats signed a result for B, a member held by five seats: the short seats waited on each other`);
    assert.equal(settled.state, 'ACCEPTED', `the winner was never paid: ${settled && settled.why}`);
  } finally { await w.close(); }
});
