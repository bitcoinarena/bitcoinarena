// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-find-h2h candidate 4: A BACKDATED NAME RECORD FROM ONE SEAT BOOKS ONLY THE WINS (P1, P11 - a way round #1263 / #1401 through #1851).
// #1263 fixed a head-to-head round's identity at its entry close: /name refuses after it, so a player cannot name himself only for the rounds he won.
// #1851 then let a seat CARRY a missed name record from a peer's GET /names at the close (verify.js carryReveals -> carryNames), "taken only if its
// signed atMs is at or before the entry close". That atMs is the player's own word: the record is signed by the player's round key, so he can sign one
// after the close with any atMs he likes. The attacker plays with no identity, reads the opponent's reveal, and only when he won signs a backdated
// record with his identity's consent and hands it to ONE seat he runs (or that takes it late); every honest seat carries it at the close and books his
// win to his identity (season board, badges, the leaderboard payout from the reserves) - his losses stay on bare round keys.
// Safe behaviour: an honest seat that took no name record of the player before the close does not book his entry to an identity that only one peer
// serves after the close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { wait } from './window-fixture.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { H2H_REVEAL_HOLD_MS } from '../src/server.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const keypair = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const player = (n) => { const k = keypair(); return { name: `p${n}`, key: k.key, secret: k.secret, worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] }; };
const proof = (identity, rid, eid) => ({ key: toHex(identity.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: identity.key }), identity.secret)) });

test('#1489 r1-h2h-4: a name record signed after the close with a backdated atMs, served by one seat, is not carried by an honest seat', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const MALLORY = keypair();
    const pm = player(1), pv = player(2);
    const sm = new Uint8Array(randomBytes(32)), sv = new Uint8Array(randomBytes(32));
    const m = await lockAndPlay(w, pm, { hidden: { move: ROCK, salt: sm }, noMarks: true });
    const v = await lockAndPlay(w, pv, { hidden: { move: SCISSORS, salt: sv }, noMarks: true });
    // Mallory names NO identity before the close (so a loss would stay on a bare round key)
    skipTo(Number(w.c.entryCloseMs) + 500);
    // the victim reveals first; Mallory reads it (rock beats scissors: she won) ...
    const postReveal = (d, played, move, s, identity) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
      { method: 'POST', body: JSON.stringify({ move, salt: toHex(s), ...(identity ? { identity: proof(identity, w.rid, played.eid) } : {}) }) }).then((r) => r.status);
    const victim = await Promise.all(w.nodes.map((d) => postReveal(d, v, SCISSORS, sv, null)));
    // ... and only now signs a name record with her identity's consent, its atMs set 10 s BEFORE the close
    const rec = { roundId: w.rid, playerPubkey: pm.key, identityPubkey: MALLORY.key, name: '', atMs: BigInt(Number(w.c.entryCloseMs) - 10000) };
    const record = encodeLobbyName(rec), sig = schnorr.sign(lobbyNameId(rec), pm.secret);
    const identitySig = schnorr.sign(matchProofId({ roundId: w.rid, entryId: pm.key, identityKey: MALLORY.key }), MALLORY.secret);
    // the honest door refuses it after the close (#1263) ...
    const honestDoor = await fetch(`http://127.0.0.1:${w.nodes[1].port}/name`, { method: 'POST', body: JSON.stringify({ record: toHex(record), sig: toHex(sig), identitySig: toHex(identitySig) }) }).then((r) => r.status);
    // ... so she hands it to seat 0, the one seat she runs, which stores it as if taken before the close
    w.nodes[0].round.putLobbyName({ roundId: w.rid, playerPubkey: pm.key, record, signature: sig, atMs: rec.atMs, identitySig });
    const mallory = await Promise.all(w.nodes.map((d) => postReveal(d, m, ROCK, sm, MALLORY)));
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 200);
    await closeRound(w, { window: false });
    // the close decides and carries in the background: wait for the honest seat's verdict on Mallory's entry (its match record, as sm3-h2h-1 reads it)
    for (let i = 0; i < 40; i++) { const j = await (await fetch(`http://127.0.0.1:${w.nodes[1].port}/api/round-result?round=${toHex(w.rid)}`)).json(); if (j.match || (j.results && j.results.length >= 2)) break; await wait(200); }
    await wait(500);
    const at1 = w.nodes[1].round.identityOf(m.eid);
    const facts = { victim, honestDoor, mallory, consentAtHonestSeat: w.nodes[1].round.consentedIdentityOf(w.rid, pm.key), identityAtHonestSeat: at1 ? toHex(at1.identity) : null, mallory16: toHex(MALLORY.key).slice(0, 16) };
    console.log('  FACTS r1-h2h-4:', JSON.stringify(facts));
    assert.equal(honestDoor, 409, 'the fixture: the honest door refuses a name record after a head-to-head close (#1263)');
    assert.equal(facts.identityAtHonestSeat, null, `the honest seat booked Mallory's won round to the identity she named only after the result, carried from one seat: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
