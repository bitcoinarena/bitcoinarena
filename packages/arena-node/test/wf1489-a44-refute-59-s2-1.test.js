// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-59 skeptic 2, 1 (refutes #1748 + #2167): THE LOCKS-AT-ONE-SEAT VARIANT. In a paying head-to-head round, matchAt
// counts only the entries whose stake THIS seat has seen (seatedEntriesOf played). A seat that holds round 1's entries but not yet their locks
// (the client handed them to seat b only, or they crossed the network late; seat a pulls them from b with takeEntryParts at its own close)
// sees round 1 as 'not a two-player round' -> null, not UNDECIDED. Round 2 at seat a is then kept as a NEW match for good, while seat b
// signs it continued 1:1. Invariant: a round's kept match record does not depend on the order in which this seat decided its rounds.
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
const reveal = (r, played, move, salt, identity, to = r.nodes) => Promise.all(to.map(async (d) => {
  const x = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt), identity }) });
  return x.status;
}));
const resultOf = (r, d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(r.rid)}`).then((x) => x.json());

// Alice and Bob enter, name their identities, reveal after the entry close at every seat - nothing is closed here
const play = async (r, moveA, moveB, to = r.nodes, only = null) => {
  skipTo(Number(r.c.committeeTimeMs) + 20);
  const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
  const a = await lockAndPlay(r, player(), { hidden: { move: moveA, salt: sa }, noMarks: true, only });
  const b = await lockAndPlay(r, player(), { hidden: { move: moveB, salt: sb }, noMarks: true, only });
  for (const d of r.nodes) for (const [played, who] of [[a, ALICE], [b, BOB]]) {
    const pk = d.round.entriesOf(r.rid).find((x) => toHex(x.entryId) === toHex(played.eid)).entry.playerPubkey;
    d.round.putLobbyName({ roundId: r.rid, playerPubkey: pk, record: encodeLobbyName({ roundId: r.rid, playerPubkey: pk, identityPubkey: who.key, atMs: 1n }), signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 1n });
  }
  skipTo(Number(r.c.entryCloseMs) + 500);
  await reveal(r, a, moveA, sa, proof(ALICE, r.rid, a.eid), to);
  await reveal(r, b, moveB, sb, proof(BOB, r.rid, b.eid), to);
};
const matchAt = async (r, d) => { for (let i = 0; i < 60; i++) { const x = await resultOf(r, d); if (x.match) return x.match; await wait(250); } return null; };
const scoreOf = (m) => { if (!m) return null; const alice = m.identities.indexOf(toHex(ALICE.key)); return `${m.score[alice]}:${m.score[1 - alice]}${m.previousRound ? ' continued' : ' new'}`; };

test('#1489 a44-refute-59-s2-1: a seat that holds round 1 locks only after its own close signs the same round-2 match score as the seat that had them at once', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    // ROUND 1: Alice wins. Both players' locks reach seat b only (index 1); seat a holds the entries, names and reveals, and pulls the locks at its close
    await play(w, ROCK, SCISSORS, w.nodes, [1]);
    await closeRound({ ...w, nodes: [w.b] }, { window: false });
    const m1b = await matchAt(w, w.b);
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    await play(w2, ROCK, PAPER);
    await closeRound(w2, { window: false });
    const early = await Promise.all(w2.nodes.map((d) => matchAt(w2, d)));
    await closeRound({ ...w, nodes: [w.a] }, { window: false });
    const m1a = await matchAt(w, w.a);
    const late = await Promise.all(w2.nodes.map((d) => matchAt(w2, d)));
    console.log('  FACTS a44-refute-59-s2-1:', JSON.stringify({ round1: { b: scoreOf(m1b), a: scoreOf(m1a) }, round2Early: early.map(scoreOf), round2Late: late.map(scoreOf) }));
    assert.equal(scoreOf(m1b), '1:0 new', 'seat b: round 1 Alice 1:0');
    assert.equal(scoreOf(m1a), scoreOf(m1b), 'round 1: both seats count Alice 1:0 once seat a pulled the locks');
    assert.equal(scoreOf(late[1]), '1:1 continued', 'seat b: round 2 continues the match from round 1');
    assert.equal(scoreOf(late[0]), scoreOf(late[1]), 'seat a signs the same round-2 score as seat b once it has decided round 1');
  } finally { await w.close(); }
});
