// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HEAD-TO-HEAD ROUND ON TWO SIGNER NODES (2026-10-09: "Head-to-head in engine"): two players enter a
// paying round of Rock Paper Scissors (test/plugins/rps - the game's own decide adapter under a test developer key), each
// hiding its move behind a commitment; after entry close each reveals to both nodes; at the round's end every node pulls
// the other's reveals, decides with the game's adapter and signs each entry's result; the round settles ACCEPTED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);          // entry close -> the round's end: the reveal window
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return { outcome: p.outcome, score: p.score, core: toHex(p.simCoreHash) };
}));
const reveal = async (w, played, move, salt) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) });
  return `${r.status} ${(await r.text()).trim().slice(0, 90)}`;
}));

test('rock beats scissors: two players hide, reveal after entry close, both nodes decide alike, the round settles ACCEPTED', async () => {
  assert.ok(SPAN_MS >= 10000 && SPAN_MS <= 60000, `the round's reveal window ${SPAN_MS} ms is outside the game's 10 s to 60 s`);
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    // THE COMMITTEE FORMS FIRST (entry opens then), and the entries come before entry close
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const saltA = new Uint8Array(randomBytes(32)), saltB = new Uint8Array(randomBytes(32));
    const A = { name: 'rock', key: b32(0x41), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] };
    const B = { name: 'scissors', key: b32(0x42), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] };
    const a = await lockAndPlay(w, A, { hidden: { move: ROCK, salt: saltA }, noMarks: true, address: true });
    const b = await lockAndPlay(w, B, { hidden: { move: SCISSORS, salt: saltB }, noMarks: true, address: true });
    // BEFORE ENTRY CLOSE no move is revealed
    const entered = Number(w.c.entryCloseMs) - testNow();
    assert.ok(entered > 0, `the entries took past entry close (${entered} ms)`);
    const early = await reveal(w, a, ROCK, saltA);
    skipTo(Number(w.c.entryCloseMs) + 500);
    const wrong = await reveal(w, b, ROCK, saltB);                  // not what B committed to
    const revealedA = await reveal(w, a, ROCK, saltA);
    // B REVEALS TO ONE NODE ONLY: the other must pull it at the close
    const r = await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveal?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify({ move: SCISSORS, salt: toHex(saltB) }) });
    const revealedB = `${r.status}`;
    await closeRound(w);
    const settled = await untilSettled(w);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    console.log('  FACTS (head-to-head):', JSON.stringify({ spanMs: SPAN_MS, early, wrong, revealedA, revealedB, state: settled.state, why: settled.why, results: got }));
    assert.ok(early.every((x) => x.startsWith('409') && /only after entry close/.test(x)), JSON.stringify(early));
    assert.ok(wrong.every((x) => x.startsWith('409') && /not what this entry committed/.test(x)), JSON.stringify(wrong));
    assert.deepEqual(revealedA.map((x) => x.slice(0, 3)), ['201', '201']);
    assert.equal(revealedB, '201');
    for (const [k, per, want] of [['rock', got.a, { outcome: 'DELIVERED', score: 2 }], ['scissors', got.b, { outcome: 'FAILED', score: 0 }]])
      for (const [i, held] of per.entries()) {
        assert.ok(held.length >= 1, `${k}: node ${i} holds no signed result`);
        for (const x of held) assert.deepEqual(x, { ...want, core: RPS_CORE.hash }, `${k} at node ${i}`);
      }
    assert.equal(settled.state, 'ACCEPTED', settled.why);
  } finally { await w.close(); }
});

// THE TWO OTHER ENDINGS, through the same nodes and settlement: a draw (both keep their stakes) and a no-show (no reveal:
// FORFEIT, and the one who revealed wins). Each its own round.
async function playRound({ moveA, moveB, revealB = true }) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const P = (k) => ({ name: `p${k}`, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
    const a = await lockAndPlay(w, P(0x51), { hidden: { move: moveA, salt: sa }, noMarks: true, address: true });
    const b = await lockAndPlay(w, P(0x52), { hidden: { move: moveB, salt: sb }, noMarks: true, address: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, moveA, sa);
    if (revealB) await reveal(w, b, moveB, sb);
    await closeRound(w);
    const settled = await untilSettled(w);
    return { state: settled.state, why: settled.why, a: results(w, a.eid), b: results(w, b.eid) };
  } finally { await w.close(); }
}
const only = (per) => { const all = per.flat().map((x) => `${x.outcome} ${x.score}`); return [...new Set(all)]; };

test('paper against paper is a draw at both nodes: both DELIVERED 1, below min_score - nobody pays anybody; settled', async () => {
  const r = await playRound({ moveA: 1, moveB: 1 });
  console.log('  FACTS (draw):', JSON.stringify({ state: r.state, a: only(r.a), b: only(r.b) }));
  assert.deepEqual([only(r.a), only(r.b)], [['DELIVERED 1'], ['DELIVERED 1']]);
  assert.equal(r.state, 'ACCEPTED', r.why);
});

test('a player who never reveals forfeits at both nodes, and the one who revealed wins; settled ACCEPTED', async () => {
  const r = await playRound({ moveA: 2, moveB: 0, revealB: false });                 // scissors would have lost to rock
  console.log('  FACTS (no-show):', JSON.stringify({ state: r.state, why: r.why && r.why.slice(0, 120), a: only(r.a), b: only(r.b) }));
  assert.deepEqual([only(r.a), only(r.b)], [['DELIVERED 2'], ['FORFEIT 0']]);
  assert.equal(r.state, 'ACCEPTED', r.why);
});

test('one player alone is not played (2026-10-09: "there must be 2 before the game starts"): VOID at both nodes, the stake back', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const salt = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, { name: 'alone', key: b32(0x61), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] },
      { hidden: { move: 0, salt }, noMarks: true, address: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, 0, salt);
    await closeRound(w);
    const r = results(w, a.eid);
    let st = null; for (const stop = Date.now() + 15000; Date.now() < stop; await new Promise((x) => setTimeout(x, 250))) { st = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/lock-settlement?round=${toHex(w.rid)}`)).json(); if (st.state && st.state !== 'NONE') break; }
    console.log('  FACTS (alone):', JSON.stringify({ results: only(r), state: st && st.state, why: st && st.why && st.why.slice(0, 160) }));
    assert.deepEqual(only(r), ['VOID 0']);
  } finally { await w.close(); }
});

