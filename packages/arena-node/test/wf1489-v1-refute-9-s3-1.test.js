// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, skeptic 3, after ce2708047): the lock claim is a signature by the ENTRY'S OWN stake point
// (lockClaimKeyOf(entry)). The copier picks that point himself: a copy of the player's entry with HIS OWN stake point P' (his own
// handout dealt under the player's key, stakeCommitment H(p')) and the player's feePreimage, fee lock outpoint and stake lock outpoint.
// The fee lock is bound to H(F) only, never to the stake point, so the copy still matches the player's fee lock field by field - and
// the copier signs a VALID claim for the copy with p'. At a seat the copy reached first, the "claimed" branch of namedFirstByAnother
// then hands the player's fee lock to the copy (the copy is claimed and was taken first there) and refuses the player's own fee lock and
// stake lock - the very effect of the original attack, now through the claim that was meant to stop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { feldmanGroup } from '../src/curve.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 refute-9-s3-1: a copy under the copier\'s own stake point claims itself and takes the player\'s fee lock', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the page reached seat 0 (handout, entry, claim); the relay has not reached seat 1 yet, no lock handed yet
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, unreached: [1] });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`, s1 = `http://127.0.0.1:${w.nodes[1].port}`;
    // THE STRANGER: reads seat 0's public doors only
    const seen = decodeEntryContract(new Uint8Array(await (await fetch(`${s0}/entry?id=${toHex(victim.eid)}`)).arrayBuffer()));
    const p2 = secretScalar(), e2 = rand(32);
    const dealt = await dealHandout({ preimage: p2, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: seen.playerPubkey,
      ephemeralSecret: e2, ephemeralPubkey: feldmanGroup.pointX(e2), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed || 2, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const copy = { ...seen, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(p2), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0] };
    const copyId = entryId(copy);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(seen.feePreimage) }, amountMsat: seen.feeMsat,
      claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
    const h = await fetch(`${s1}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) }); const hw = await h.text();
    const e = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); const ew = await e.text();
    const c = await fetch(`${s1}/lock-claim?entry=${toHex(copyId)}`, { method: 'POST', body: schnorr.sign(lockClaimDigest(copyId), p2) }); const cw = await c.text();
    const f = await fetch(`${s1}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }); const fw = await f.text();
    const attacker = { handout: [h.status, hw.slice(0, 80)], entry: [e.status, ew.slice(0, 80)], claim: [c.status, cw.slice(0, 80)], fee: [f.status, fw.slice(0, 120)] };
    // the page goes on: its handout, entry and claim to seat 1, then its locks to every seat
    const vh = await fetch(`${s1}/handout`, { method: 'POST', body: new Uint8Array(await (await fetch(`${s0}/handout?id=${toHex(seen.vssSharesRef)}`)).arrayBuffer()) }); await vh.text();
    const j1 = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(victim.entry) }); const j1w = await j1.text();
    const vc = await fetch(`${s1}/lock-claim?entry=${toHex(victim.eid)}`, { method: 'POST', body: new Uint8Array(await (await fetch(`${s0}/lock-claim?entry=${toHex(victim.eid)}`)).arrayBuffer()) }); await vc.text();
    const mine = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const r = await fetch(`${base}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const rf = await fetch(`${base}/fee-lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      mine.push({ lock: r.status, why: (await r.text()).slice(0, 120), fee: rf.status, feeWhy: (await rf.text()).slice(0, 120) });
    }
    const held = w.nodes.map((d) => ({ victimFee: !!d.round.feeLock(victim.eid), copyFee: !!d.round.feeLock(copyId), victimSeen: !!d.round.stakeSeen(victim.eid) }));
    console.log('  FACTS refute-9-s3-1:', JSON.stringify({ attacker, victimJoin1: [j1.status, j1w.slice(0, 80)], victimClaim1: vc.status, mine, held }));
    for (const [i, s] of held.entries()) assert.equal(s.copyFee, false, `seat ${i} took the player's fee lock for the copier's self-claimed copy`);
    for (const m of mine) { assert.equal(m.fee, 201, `the player's own fee lock was refused: ${m.feeWhy}`); assert.equal(m.lock, 201, `the player's own stake lock was refused: ${m.why}`); }
  } finally { await w.close(); }
});
