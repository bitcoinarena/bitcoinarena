// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCORE ACROSS ROUNDS (2026-10-09: "I win: 1:0. Opponent wins: 1:1. It keeps counting until one
// player or both leave. The protocol counts it up, attests it, and shows it in the results"; "On /dashboard ... which kind of
// game was played, and the score"). Two identities play Rock Paper Scissors round after round on the same two seats: each
// reveal names its identity (signed by that identity key); each seat counts the match, signs it, serves it with the round's
// result and on its dashboard. A pause past the match's continue time starts a new match at 0:0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, openLockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, skipBy, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId, matchRecordId, MATCH_CONTINUE_MS } from '../../arena-protocol/src/match.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
// two players: each its identity key (the tab's), a fresh player key per round as the page derives one
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const ALICE = ident(), BOB = ident();
let k = 0x60;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const proof = (who, rid, eid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: who.key }), who.secret)) });
const reveal = (r, played, move, salt, identity) => Promise.all(r.nodes.map(async (d) => {
  const x = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt), ...(identity ? { identity } : {}) }) });
  return `${x.status} ${(await x.text()).trim().slice(0, 100)}`;
}));
const resultOf = (r, d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(r.rid)}`).then((x) => x.json());

test('the same two players round after round: 1:0, 1:1, a draw keeps 1:1; both seats count and sign it alike; a pause starts 0:0; the dashboard names the kind and the score', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const rounds = [];
  // ONE ROUND: Alice and Bob enter, reveal after entry close naming their identities, the seats decide at the close
  const play = async (r, moveA, moveB, { forged = false } = {}) => {
    skipTo(Number(r.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(r, player(), { hidden: { move: moveA, salt: sa }, noMarks: true });
    const b = await lockAndPlay(r, player(), { hidden: { move: moveB, salt: sb }, noMarks: true });
    skipTo(Number(r.c.entryCloseMs) + 500);
    const bad = forged ? await reveal(r, a, moveA, sa, proof(BOB, r.rid, a.eid) && { key: toHex(ALICE.key), sig: proof(BOB, r.rid, a.eid).sig }) : null;
    await reveal(r, a, moveA, sa, proof(ALICE, r.rid, a.eid));
    await reveal(r, b, moveB, sb, proof(BOB, r.rid, b.eid));
    await closeRound(r, { window: false });
    let res;
    for (let i = 0; i < 40; i++) { res = await Promise.all(r.nodes.map((d) => resultOf(r, d))); if (res.every((x) => x.match)) break; await wait(250); }
    rounds.push({ close: Number(r.c.entryCloseMs), res });
    return { res, bad };
  };
  const scoreOf = (res) => { const m = res.match; const alice = m.identities.indexOf(toHex(ALICE.key)); return `${m.score[alice]}:${m.score[1 - alice]}`; };
  try {
    const r1 = await play(w, ROCK, SCISSORS, { forged: true });              // Alice wins
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const r2 = await play(w2, ROCK, PAPER);                                    // Bob wins
    const w3 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const r3 = await play(w3, SCISSORS, SCISSORS);                            // a draw
    skipBy(Number(MATCH_CONTINUE_MS) + 30000);                                  // both sit out longer than the match lasts
    const w4 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const r4 = await play(w4, PAPER, ROCK);                                    // Alice wins - a new match
    const scores = [r1, r2, r3, r4].map((x) => x.res.map(scoreOf));
    const gapsS = rounds.slice(1).map((x, i) => Math.round((x.close - rounds[i].close) / 1000));
    // EACH SEAT SIGNED IT: its key over the record's id
    const m = r2.res[0].match;
    const id = matchRecordId({ gameId: fromHex(m.game), roundId: fromHex(m.round), identities: m.identities, score: m.score, previousRoundId: m.previousRound ? fromHex(m.previousRound) : null });
    const signed = r2.res.map((x) => schnorr.verify(fromHex(x.match.signature), id, fromHex(x.match.seat)));
    const dash = await fetch(`http://127.0.0.1:${w.a.port}/dashboard.json`).then((x) => x.json());
    const row = dash.rounds.find((x) => x.id === toHex(w2.rid));
    console.log('  MATCH:', JSON.stringify({ scores, gapsS, continued: [r1, r2, r3, r4].map((x) => x.res[0].match.previousRound ? 'yes' : 'no'), signed,
      forged: r1.bad && r1.bad[0], dashboard: row && { game: row.gameName, kind: row.kind, score: row.score } }));
    assert.match(r1.bad[0], /^403 that identity is not signed by its key over this round and entry/);
    assert.deepEqual(scores, [['1:0', '1:0'], ['1:1', '1:1'], ['1:1', '1:1'], ['1:0', '1:0']]);
    assert.deepEqual([r1, r2, r3, r4].map((x) => !!x.res[0].match.previousRound), [false, true, true, false]);
    assert.deepEqual(signed, [true, true]);
    assert.ok(r2.res[0].match.names.length === 2);
    assert.equal(row.kind, 'head-to-head');
    assert.deepEqual(row.score.score, m.score);
  } finally { await w.close(); }
});
