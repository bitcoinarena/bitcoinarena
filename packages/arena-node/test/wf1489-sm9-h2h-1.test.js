// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 9 (h2h): THE MATCH ACROSS ROUNDS (match.js) continues only when "the last round of this game either
// identity played" was a round the two played together. matchOf finds an identity's rounds by roundsOfIdentity, which reads h2h_identities only -
// the identity a REVEAL carried. Since audit 5 #1401 a round's sides are named by the consented name record too (a forfeiter, who sent no reveal),
// but the look for "the round before" still ignores them: a player who forfeits a round against someone else is not seen to have played it, and his
// next meeting with the old opponent continues the old score instead of starting at 0:0. Invariant: a round between them with a third player ends
// the match (the next record names no previous round).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, openLockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId, MATCH_CONTINUE_MS } from '../../arena-protocol/src/match.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const ALICE = ident(), BOB = ident(), CAROL = ident();
let k = 0x30;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const proof = (who, rid, eid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: who.key }), who.secret)) });
const reveal = (r, played, move, salt, identity) => Promise.all(r.nodes.map(async (d) => {
  const x = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt), identity }) });
  return x.status;
}));
const resultOf = (r, d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(r.rid)}`).then((x) => x.json());

test('wf1489-sm9-h2h-1: a player who forfeited a round against a third player is still read as having played only the old match - its score goes on', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const closes = [];
  // ONE ROUND: [who, move, reveals?] for each side; every side named by its consented name record, as the page posts it at the join
  const play = async (r, sides) => {
    skipTo(Number(r.c.committeeTimeMs) + 20);
    const played = [];
    for (const [who, move] of sides) { const salt = new Uint8Array(randomBytes(32)); played.push({ who, move, salt, p: await lockAndPlay(r, player(), { hidden: { move, salt }, noMarks: true }) }); }
    for (const d of r.nodes) for (const x of played) {
      const pk = d.round.entriesOf(r.rid).find((e) => toHex(e.entryId) === toHex(x.p.eid)).entry.playerPubkey;
      d.round.putLobbyName({ roundId: r.rid, playerPubkey: pk, record: encodeLobbyName({ roundId: r.rid, playerPubkey: pk, identityPubkey: x.who.key, atMs: 1n }), signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 1n });
    }
    skipTo(Number(r.c.entryCloseMs) + 500);
    for (let i = 0; i < played.length; i++) if (sides[i][2] !== false) await reveal(r, played[i].p, played[i].move, played[i].salt, proof(played[i].who, r.rid, played[i].p.eid));
    await closeRound(r, { window: false });
    let res;
    for (let i = 0; i < 40; i++) { res = await Promise.all(r.nodes.map((d) => resultOf(r, d))); if (res.every((x) => x.match)) break; await wait(250); }
    closes.push(Number(r.c.entryCloseMs));
    return res;
  };
  try {
    const r1 = await play(w, [[ALICE, ROCK], [BOB, SCISSORS]]);                                   // Alice beats Bob: 1:0
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const r2 = await play(w2, [[BOB, PAPER, false], [CAROL, ROCK]]);                              // Bob plays Carol - and does not reveal (forfeit)
    const w3 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
    const r3 = await play(w3, [[ALICE, PAPER], [BOB, ROCK]]);                                     // Alice and Bob meet again
    const gapsMs = closes.slice(1).map((x, i) => x - closes[i]);
    const facts = {
      gapsMs, continueMs: Number(MATCH_CONTINUE_MS),
      r1: r1.map((x) => x.match && x.match.score),
      r2: r2.map((x) => x.match && { ids: x.match.identities.map((i) => i.slice(0, 8)), score: x.match.score, played: x.match.played }),
      r3: r3.map((x) => x.match && { score: x.match.score, previousRound: x.match.previousRound && x.match.previousRound.slice(0, 16) }),
      r1id: toHex(w.rid).slice(0, 16),
    };
    console.log('  FACTS:', JSON.stringify(facts));
    // the rounds are back to back: without Bob's round with Carol the match would continue
    assert.ok(closes[2] - closes[0] <= Number(MATCH_CONTINUE_MS), `the rounds are within the match's continue time (${gapsMs})`);
    // Bob played round 2 (his side counted there, through his consented record)
    assert.ok(r2.every((x) => x.match && x.match.played), 'round 2 is a played match between Bob and Carol');
    // INVARIANT: Bob's last round before round 3 was with Carol, so round 3 starts a new match
    assert.deepEqual(r3.map((x) => x.match.previousRound), r3.map(() => null), 'round 3 continues no earlier round: Bob played Carol in between');
    const aliceAt = r3[0].match.identities.indexOf(toHex(ALICE.key));
    assert.deepEqual(r3.map((x) => x.match.score[aliceAt]), r3.map(() => 1), 'Alice wins round 3 of a new match: 1:0, not 2:0');
  } finally { await w.close(); }
});
