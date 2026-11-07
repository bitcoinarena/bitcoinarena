// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1278 (RULED #1276, audit 4 #1257 PLAYER-3): a name record is signed by the round key only, so a player booked his own losses to a rival's
// identity. Now a round books to an identity only with that identity key's signature over (round id, round key), posted beside the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { seasonRoundOf } from '../src/season-read.js';
import { assumeAssigned } from './assignment.js';
import { b32, rand, contractFor } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('#1278 a record naming an identity books the round to it only with that identity\'s own proof; a forged proof is refused', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, lobbyNameGraceMs: 60000 });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const c = { ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [base]), committeeTimeMs: now - 1000n, startTimeMs: now + 59000n, entryCloseMs: now + 179000n, stakeMsat: 0n };
    assert.equal((await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    const rid = roundId(c);
    assumeAssigned(d.round, rid, c.nodes);
    const join = async () => {
      const secret = schnorr.utils.randomSecretKey();
      const entry = { roundId: rid, playerPubkey: schnorr.getPublicKey(secret), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
        stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
        feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) };
      assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
      return { secret, pub: entry.playerPubkey };
    };
    const identity = () => { const s = schnorr.utils.randomSecretKey(); return { secret: s, pub: schnorr.getPublicKey(s) }; };
    const proofOf = (who, p) => toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: p.pub, identityKey: who.pub }), who.secret));
    const post = async (p, who, identitySig) => { const r = { roundId: rid, playerPubkey: p.pub, identityPubkey: who.pub, name: 'Road Owl', atMs: 1000n };
      const x = await fetch(`${base}/name`, { method: 'POST', body: JSON.stringify({ record: toHex(encodeLobbyName(r)), sig: toHex(schnorr.sign(lobbyNameId(r), p.secret)), ...(identitySig ? { identitySig } : {}) }) });
      return x.status; };
    const RIVAL = identity(), ALICE = identity(), MALLORY = identity();
    const griefer = await join(), alice = await join(), forger = await join();
    const unproven = await post(griefer, RIVAL, null);                    // the rival's identity, no consent
    const proven = await post(alice, ALICE, proofOf(ALICE, alice));        // her own, with her proof
    const forged = await post(forger, RIVAL, proofOf(MALLORY, forger));    // a proof by another key
    const names = (await (await fetch(`${base}/names?round=${toHex(rid)}`)).json()).names;
    const s = seasonRoundOf(d.round, rid, c);
    const bookedTo = (p) => s.entries.find((e) => e.roundKey === toHex(p.pub)).player;
    const facts = { unproven, proven, forged, servedProofs: names.filter((n) => n.identitySig).length,
      griefersRound: bookedTo(griefer) === toHex(RIVAL.pub) ? 'rival' : bookedTo(griefer) === toHex(griefer.pub) ? 'bare key' : '?',
      alicesRound: bookedTo(alice) === toHex(ALICE.pub) ? 'alice' : 'other' };
    console.log('  FACTS #1278:', JSON.stringify(facts));
    assert.equal(unproven, 201, 'a record without a proof is still taken for the lobby');
    assert.equal(proven, 201);
    assert.equal(forged, 400, 'a proof by another key was taken');
    assert.equal(facts.griefersRound, 'bare key', 'a record without the identity\'s consent booked the round to that identity');
    assert.equal(facts.alicesRound, 'alice');
    assert.equal(facts.servedProofs, 1, 'GET /names serves the proof held');
  } finally { await d.close(); }
});
