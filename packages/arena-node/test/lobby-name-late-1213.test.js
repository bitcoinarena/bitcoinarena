// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1213 (audit 2 #1204 MKT-1): a round's name record names the identity its entry is booked to on the season board and the
// leaderboard, and the newest record won at any time - a player could name only the rounds he had won, after they settled, and be paid
// from the reserves by results he picked afterwards (or book a lost round to a rival). Now no record is taken after the round's entry
// close (plus a grace for a join's own record still on its way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { b32, rand, contractFor } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('#1213 a name record before the entry close is kept; after it (and its grace) none is - the identity a round is booked to is fixed', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, lobbyNameGraceMs: 60000 });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const c = { ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [base]),
      committeeTimeMs: now - 1000n, startTimeMs: now + 59000n, entryCloseMs: now + 179000n, stakeMsat: 0n };
    assert.equal((await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    const rid = roundId(c);
    assumeAssigned(d.round, rid, c.nodes);
    const player = schnorr.utils.randomSecretKey();
    const entry = {
      roundId: rid, playerPubkey: schnorr.getPublicKey(player),
      sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
      feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    const rec = (identity, atMs) => ({ roundId: rid, playerPubkey: entry.playerPubkey, identityPubkey: identity, name: 'Road Owl 42', atMs });
    const post = async (r) => { const x = await fetch(`${base}/name`, { method: 'POST', body: JSON.stringify({ record: toHex(encodeLobbyName(r)), sig: toHex(schnorr.sign(lobbyNameId(r), player)) }) }); return { status: x.status, why: (await x.json()).why }; };
    const bookedTo = async () => (await (await fetch(`${base}/names?round=${toHex(rid)}`)).json()).names.map((n) => toHex(decodeLobbyName(fromHex(n.record)).identityPubkey));

    const atJoin = await post(rec(b32(7), 1000n));
    assert.equal(atJoin.status, 201, String(atJoin.why));
    // past the entry close and its grace: the round's result may be known now
    d.round.now = () => Number(c.entryCloseMs) + 60001;          // the seat's clock: past the entry close and its minute's grace
    const inGrace = await (async () => { d.round.now = () => Number(c.entryCloseMs) + 30000; const x = await post(rec(b32(7), 1500n)); d.round.now = () => Number(c.entryCloseMs) + 60001; return x.status; })();
    const late = await post(rec(b32(8), 9000n));                  // another identity, a newer atMs: newest-wins took it before
    const lateSame = await post(rec(b32(7), 9500n));              // the same identity again: refused all the same
    console.log('  MEASURED #1213:', JSON.stringify({ atJoin: atJoin.status, inGrace, late, lateSame: lateSame.status, bookedTo: (await bookedTo()).map((x) => x.slice(0, 8)) }));
    assert.equal(inGrace, 201, 'a record inside the grace is still taken');
    assert.equal(late.status, 409);
    assert.match(late.why, /entry closed/);
    assert.equal(lateSame.status, 409);
    assert.deepEqual(await bookedTo(), [toHex(b32(7))], 'still booked to the identity named at the join');
  } finally { await d.close(); }
});
