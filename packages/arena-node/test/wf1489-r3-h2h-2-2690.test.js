// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3, head-to-head: A STRANGER TAKES THE SECOND SEAT OF A FREE HEAD-TO-HEAD ROUND UNDER THE HONEST PLAYER'S OWN ROUND KEY,
// AND HIS FORFEIT IS BOOKED TO HER IDENTITY.
// An entry carries no signature of its player key, and a free round's one-entry rule (#1479/#1597) refuses only the same SESSION key under the
// same player key. A stranger reads Alice's entry (GET /entry: her player key is public) and posts an entry of his own - his own session key and
// commitment - naming HER player key. It takes the table's second seat, and her consented name record (kept per round and player key) books
// it to her identity: on the season board (season-read.js seasonRoundOf) Alice's identity then carries the stranger's FORFEIT (he never
// reveals) or any loss he chooses. Safe: an entry Alice did not make is never booked to her identity - refused at the door, or booked to no one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seasonRoundOf } from '../src/season-read.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const keypair = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const player = (n, k = keypair()) => ({ name: `p${n}`, key: k.key, secret: k.secret, worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });
const nameBody = (rid, who, identity) => {
  const rec = { roundId: rid, playerPubkey: who.key, identityPubkey: identity.key, name: 'alice', atMs: BigInt(testNow()) };
  return JSON.stringify({ record: toHex(encodeLobbyName(rec)), sig: toHex(schnorr.sign(lobbyNameId(rec), who.secret)),
    identitySig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: who.key, identityKey: identity.key }), identity.secret)) });
};
const proof = (identity, rid, eid) => ({ key: toHex(identity.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: identity.key }), identity.secret)) });

test('#1489 r3 h2h-2: a stranger\'s entry under the honest player\'s round key takes the free seat and its forfeit is booked to her identity', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const ALICE = keypair();
    const alice = player(1);
    const sa = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, alice, { session: alice.session, hidden: { move: ROCK, salt: sa }, noMarks: true, only: [], feeLock: false });
    const names = [];
    for (const d of w.nodes) names.push(await fetch(`http://127.0.0.1:${d.port}/name`, { method: 'POST', body: nameBody(w.rid, alice, ALICE) }).then((r) => r.status));
    // the stranger: Alice's PUBLIC player key, his own session key and move (he holds no secret of hers)
    const copy = { ...alice, secret: null, session: ed25519.utils.randomSecretKey() };
    let stranger, s = null;
    try { s = await lockAndPlay(w, copy, { session: copy.session, hidden: { move: PAPER, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); stranger = 'taken'; }
    catch (e) { stranger = String(e.message).split('\n')[0].slice(0, 200); }
    skipTo(Number(w.c.entryCloseMs) + 500);
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(a.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sa), identity: proof(ALICE, w.rid, a.eid) }) });
    await closeRound(w);
    const d0 = w.nodes[0];
    const read = () => seasonRoundOf(d0.round, w.rid, decodeRoundContract(new Uint8Array(d0.round.get(w.rid).contract)));
    let season = read();
    for (const stop = Date.now() + 15000; Date.now() < stop && season.entries.some((e) => e.outcome === null); await new Promise((ok) => setTimeout(ok, 200))) season = read();
    const rows = season.entries.map((e) => ({ player: e.player.slice(0, 16), outcome: e.outcome, score: e.score }));
    console.log('  FACTS (#1489 r3 h2h-2):', JSON.stringify({ names, stranger, rows, alice: toHex(ALICE.key).slice(0, 16) }));
    const hers = season.entries.filter((e) => e.player === toHex(ALICE.key));
    assert.equal(hers.length, 1, `entries Alice never made are booked to her identity on the season board: ${JSON.stringify(rows)}`);
  } finally { await w.close(); }
});
