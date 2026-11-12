// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-h2h 2: A MATCH RECORD COUNTED BEFORE THE ROUND BEFORE IT WAS DECIDED HERE IS KEPT WITH THE MATCH BROKEN, FOR GOOD.
// match.js matchOf keeps a round's match record (INSERT OR IGNORE, never revisited) the first time anything reads it - /api/round-result,
// /dashboard.json. It continues the match only from a previous round whose own record it can build now; a previous round not yet decided
// at this seat (no result held: its close still waiting on its members or on a slow peer's /reveals, or a restart resuming closes one at
// a time) gives null, so the later round is kept as a NEW match - 0:0 plus this round - and every round after continues from that number.
// The seat that had decided the round before keeps the true score: two seats sign two different scores for the same round, and the
// late seat never corrects its own.
// Invariant: a round's kept match record does not depend on the order in which this seat decided its rounds - every seat signs the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, openLockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const ALICE = ident(), BOB = ident();
let k = 0x70;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const proof = (who, rid, eid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: who.key }), who.secret)) });
const reveal = (r, played, move, salt, identity) => Promise.all(r.nodes.map(async (d) => {
  const x = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt), identity }) });
  return x.status;
}));
const resultOf = (r, d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(r.rid)}`).then((x) => x.json());

// Alice and Bob enter, name their identities, reveal after the entry close at every seat - nothing is closed here
const play = async (r, moveA, moveB) => {
  skipTo(Number(r.c.committeeTimeMs) + 20);
  const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
  const a = await lockAndPlay(r, player(), { hidden: { move: moveA, salt: sa }, noMarks: true });
  const b = await lockAndPlay(r, player(), { hidden: { move: moveB, salt: sb }, noMarks: true });
  for (const d of r.nodes) for (const [played, who] of [[a, ALICE], [b, BOB]]) {
    const pk = d.round.entriesOf(r.rid).find((x) => toHex(x.entryId) === toHex(played.eid)).entry.playerPubkey;
    d.round.putLobbyName({ roundId: r.rid, playerPubkey: pk, record: encodeLobbyName({ roundId: r.rid, playerPubkey: pk, identityPubkey: who.key, atMs: 1n }), signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 1n });
  }
  skipTo(Number(r.c.entryCloseMs) + 500);
  await reveal(r, a, moveA, sa, proof(ALICE, r.rid, a.eid));
  await reveal(r, b, moveB, sb, proof(BOB, r.rid, b.eid));
};
const matchAt = async (r, d) => { for (let i = 0; i < 60; i++) { const x = await resultOf(r, d); if (x.match) return x.match; await wait(250); } return null; };
const scoreOf = (m) => { if (!m) return null; const alice = m.identities.indexOf(toHex(ALICE.key)); return `${m.score[alice]}:${m.score[1 - alice]}${m.previousRound ? ' continued' : ' new'}`; };

test('#1489 sm2-h2h-2: a seat that decides the round before after the next one signs the same match score as the seat that decided them in order', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    // ROUND 1: Alice wins. Seat b decides it at once; seat a's close of it is still waiting (a slow peer, its members, a restart's queue)
    await play(w, ROCK, SCISSORS);
    await closeRound({ ...w, nodes: [w.b] }, { window: false });
    const m1b = await matchAt(w, w.b);
    // ROUND 2, the next table of the same two, within the match's continue time: Bob wins. Both seats decide it; a page reads its result
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    await play(w2, ROCK, PAPER);
    await closeRound(w2, { window: false });
    const early = await Promise.all(w2.nodes.map((d) => matchAt(w2, d)));
    // seat a now decides round 1 too, and its round-2 record is read again
    await closeRound({ ...w, nodes: [w.a] }, { window: false });
    const m1a = await matchAt(w, w.a);
    const late = await Promise.all(w2.nodes.map((d) => matchAt(w2, d)));
    console.log('  FACTS sm2-h2h-2:', JSON.stringify({ round1: { b: scoreOf(m1b), a: scoreOf(m1a) }, round2Early: early.map(scoreOf), round2Late: late.map(scoreOf) }));
    assert.equal(scoreOf(m1a), scoreOf(m1b), 'round 1: both seats count Alice 1:0');
    assert.equal(scoreOf(late[1]), '1:1 continued', 'seat b: round 2 continues the match from round 1');
    assert.equal(scoreOf(late[0]), scoreOf(late[1]), 'seat a signs the same round-2 score as seat b once it has decided round 1');
  } finally { await w.close(); }
});
