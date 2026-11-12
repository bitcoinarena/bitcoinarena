// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (sm3-h2h-1): A NAME RECORD ONE SEAT MISSED IS NEVER CARRIED, SO THAT SEAT BOOKS THE HEAD-TO-HEAD ROUND TO NOBODY FOR GOOD.
// Machine: a head-to-head entry's identity per seat = lobby_names (POST /name, taken only until the entry close, kanban #1263) x h2h_identities
// (the reveal door and the close's carryReveals keep a reveal's identity only where THIS seat holds the player's consenting name record, #1224/#1401).
// The page posts its name record once to every seat at the join; one seat that did not take it (restarting, slow, a lost post) has no path to it
// afterwards: /name refuses after the entry close, the entry relay hands on the entry and its locks but no name, and carryReveals drops the identity a
// peer serves because no consent is held here. That seat keeps the entry on its bare round key - no h2h identity, no match record, the season account
// and the leaderboard booked to nobody - while the other seats book it to the player's identity. Nothing ever reconciles the two.
// Invariant: every seat of the round books a head-to-head entry to the same identity once the player's signed, consenting name record stood in time anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const keypair = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
// a player whose round key is a real key, so it can sign its name record as a page does
const player = (n) => { const k = keypair(); return { name: `p${n}`, key: k.key, secret: k.secret, worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] }; };
const nameBody = (rid, who, identity) => {
  const rec = { roundId: rid, playerPubkey: who.key, identityPubkey: identity.key, name: '', atMs: BigInt(testNow()) };
  return JSON.stringify({ record: toHex(encodeLobbyName(rec)), sig: toHex(schnorr.sign(lobbyNameId(rec), who.secret)),
    identitySig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: who.key, identityKey: identity.key }), identity.secret)) });
};
const proof = (identity, rid, eid) => ({ key: toHex(identity.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: identity.key }), identity.secret)) });

test('#1489 sm3-h2h-1: a seat that missed a player\'s name record books his head-to-head entry to no identity, while the other seat books it to his', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const ALICE = keypair(), BOB = keypair();
    const pa = player(1), pb = player(2);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, pa, { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, pb, { hidden: { move: SCISSORS, salt: sb }, noMarks: true });
    // the names go out with the join: both reach seat 0; Alice's post to seat 1 is lost (that seat was restarting), Bob's arrives
    const post = (d, body) => fetch(`http://127.0.0.1:${d.port}/name`, { method: 'POST', body }).then((r) => r.status);
    const names = { alice0: await post(w.nodes[0], nameBody(w.rid, pa, ALICE)), bob0: await post(w.nodes[0], nameBody(w.rid, pb, BOB)), bob1: await post(w.nodes[1], nameBody(w.rid, pb, BOB)) };
    skipTo(Number(w.c.entryCloseMs) + 500);
    // seat 1 is back: the page's own resend of Alice's name, after the close, is refused there; the reveals reach both seats
    names.alice1Late = await post(w.nodes[1], nameBody(w.rid, pa, ALICE));
    const rv = async (played, move, s, identity) => Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
      { method: 'POST', body: JSON.stringify({ move, salt: toHex(s), identity: proof(identity, w.rid, played.eid) }) }).then((r) => r.status)));
    const reveals = { alice: await rv(a, ROCK, sa, ALICE), bob: await rv(b, SCISSORS, sb, BOB) };
    await closeRound(w, { window: false });
    const idAt = (d, played) => { const x = d.round.identityOf(played.eid); return x ? toHex(x.identity) : null; };
    const matchAt = async (d) => { for (let i = 0; i < 40; i++) { const j = await (await fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${toHex(w.rid)}`)).json(); if (j.match) return j.match; await wait(200); } return null; };
    const matches = await Promise.all(w.nodes.map(matchAt));
    const got = { names, reveals, aliceIdentity: w.nodes.map((d) => idAt(d, a)), bobIdentity: w.nodes.map((d) => idAt(d, b)),
      match: matches.map((m) => (m ? `${m.score.join(':')}` : null)), alice: toHex(ALICE.key).slice(0, 16) };
    console.log('  FACTS sm3-h2h-1:', JSON.stringify(got));
    assert.equal(got.aliceIdentity[0], toHex(ALICE.key), 'seat 0 books Alice\'s entry to her identity');
    assert.equal(got.aliceIdentity[1], got.aliceIdentity[0], `seat 1 books Alice's entry to another identity than seat 0: ${JSON.stringify(got)}`);
    assert.deepEqual(got.match[1], got.match[0], `the two seats keep different match records for one round: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
