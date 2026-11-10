// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1263 (audit 4 #1257 PLAYER-2): a head-to-head round's identity was taken from the reveal whenever the reveal stood, and #1224 bound it only
// where a name record was held - so a player revealed with no identity, read the opponent's reveal, and posted his own again with his identity only
// when he had won (season board, badges, the leaderboard payout from the reserves). A name record 60 s after the close did the same. Now a reveal's
// identity is kept only when the seat holds the player's name record naming it, and a head-to-head round takes no record after its entry close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const keypair = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const player = (k) => ({ name: 'p', key: k.key, worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const proof = (who, rid, eid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey: who.key }), who.secret)) });
const post = async (d, path, body) => { const x = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', body: JSON.stringify(body) }); return x.status; };
const reveal = (w, played, move, salt, identity) => Promise.all(w.nodes.map((d) => post(d, `/reveal?entry=${toHex(played.eid)}`, { move, salt: toHex(salt), ...(identity ? { identity } : {}) })));
// `consent`: the identity's own signature over (round id, round key) - what the page sends at the join (kanban #1278); without it the record books nothing
const nameRecord = (w, roundKey, identity, consent = false) => { const r = { roundId: w.rid, playerPubkey: roundKey.key, identityPubkey: identity.key, name: '', atMs: BigInt(testNow()) };
  return { record: toHex(encodeLobbyName(r)), sig: toHex(schnorr.sign(lobbyNameId(r), roundKey.secret)),
    ...(consent ? { identitySig: toHex(schnorr.sign(matchProofId({ roundId: w.rid, entryId: roundKey.key, identityKey: identity.key }), identity.secret)) } : {}) }; };

test('#1263 a reveal\'s identity is kept only when the name record held names it; a head-to-head round takes no record after its close', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const kA = keypair(), kC = keypair(), ALICE = keypair(), CAROL = keypair();
    const sa = new Uint8Array(randomBytes(32)), sc = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player(kA), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const c = await lockAndPlay(w, player(kC), { hidden: { move: SCISSORS, salt: sc }, noMarks: true });
    // Carol names herself before the close with her identity's consent, as the page does at the join; Alice names herself WITHOUT consent (audit 5 #1401)
    const carolNamed = await Promise.all(w.nodes.map((d) => post(d, '/name', nameRecord(w, kC, CAROL, true))));
    const aliceNamedNoConsent = await Promise.all(w.nodes.map((d) => post(d, '/name', nameRecord(w, kA, ALICE))));
    skipTo(Number(w.c.entryCloseMs) + 5000);
    // Alice reveals with no identity, then Carol (named) - Alice won, rock over scissors - and Alice posts her reveal again with her identity
    await reveal(w, a, ROCK, sa, null);
    const carolReveal = await reveal(w, c, SCISSORS, sc, proof(CAROL, w.rid, c.eid));
    const againWithIdentity = await reveal(w, a, ROCK, sa, proof(ALICE, w.rid, a.eid));
    // and a name record for her, 5 s after the close
    const lateName = await Promise.all(w.nodes.map((d) => post(d, '/name', nameRecord(w, kA, ALICE))));
    const kept = w.nodes.map((d) => ({ alice: d.round.identityOf ? d.round.identityOf(a.eid) : null, carol: d.round.identityOf ? d.round.identityOf(c.eid) : null }));
    const toKey = (x) => (x ? toHex(x.identity || x).slice(0, 8) : null);
    console.log('  FACTS #1263:', JSON.stringify({ carolNamedBeforeClose: carolNamed, aliceRevealAgainWithIdentity: againWithIdentity, aliceNameAfterClose: lateName, carolReveal,
      identityKept: kept.map((x) => ({ alice: toKey(x.alice), carol: toKey(x.carol) })) }));
    assert.ok(carolNamed.every((s) => s === 201), 'the fixture: a record before the close is taken');
    assert.ok(lateName.every((s) => s === 409), `a name record after a head-to-head round's close was taken: ${lateName}`);
    assert.ok(aliceNamedNoConsent.every((s) => s === 201), 'the fixture: a record without consent before the close is taken');
    // AUDIT 5 #1401: the record names ALICE (no consent) and her second reveal carries ALICE's proof - before the fix that proof was the consent, given
    // after the result; now only the consent sent with the join counts
    assert.ok(kept.every((x) => !x.alice), 'an identity attached after the result was kept');
    // and the match: Carol's side from her consented record; Alice's has no consented identity, so no match record is made from a bare key
    assert.ok(w.nodes.every((d) => d.round.consentedIdentityOf(w.rid, kC.key) === toHex(CAROL.key)));
    assert.ok(w.nodes.every((d) => d.round.consentedIdentityOf(w.rid, kA.key) === null));
    assert.ok(kept.every((x) => x.carol && toKey(x.carol) === toHex(CAROL.key).slice(0, 8)), 'the identity named before the close was not kept');
  } finally { await w.close(); }
});
