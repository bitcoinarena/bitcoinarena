// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, skeptic 3, after ce2708047), variant 2: a client that sends no lock claim (a page from before it, or
// market-bot.mjs, rps-opponent.mjs, page-lock.mjs, which send none) - the commit says "without any claim the old rule stands, a peer can
// refuse, not rob". A stranger's copy under HIS OWN stake point carries HIS OWN valid claim, so the seats take the "claimed" branch: the
// copy is the only claimed entry, and it gets the player's fee lock at EVERY seat - even the seats that took the player's entry first -
// and the player's stake and fee lock are refused at every seat. Before ce2708047 the seat that took the player first kept them.
// (Original header follows.) The lock claim is a signature by the ENTRY'S OWN stake point
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

test('#1489 refute-9-s3-2: no claim from the player - a self-claimed copy takes the fee lock at every seat, even where the player was first', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the player's entry reached BOTH seats first (handout and entry), no claim (an older client), no lock handed yet
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, lockClaim: false });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`;
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
    const attacker = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const h = await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) }); await h.text();
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); await e.text();
      const c = await fetch(`${base}/lock-claim?entry=${toHex(copyId)}`, { method: 'POST', body: schnorr.sign(lockClaimDigest(copyId), p2) }); await c.text();
      const f = await fetch(`${base}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      attacker.push({ handout: h.status, entry: e.status, claim: c.status, fee: f.status, why: (await f.text()).slice(0, 100) });
    }
    const mine = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const r = await fetch(`${base}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const rf = await fetch(`${base}/fee-lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      mine.push({ lock: r.status, why: (await r.text()).slice(0, 100), fee: rf.status, feeWhy: (await rf.text()).slice(0, 100) });
    }
    const held = w.nodes.map((d) => ({ victimFee: !!d.round.feeLock(victim.eid), copyFee: !!d.round.feeLock(copyId), victimSeen: !!d.round.stakeSeen(victim.eid) }));
    console.log('  FACTS refute-9-s3-2:', JSON.stringify({ attacker, mine, held }));
    for (const [i, s] of held.entries()) assert.equal(s.copyFee, false, `seat ${i} (which took the player's entry first) gave the player's fee lock to the self-claimed copy`);
    for (const m of mine) { assert.equal(m.fee, 201, `the player's own fee lock was refused: ${m.feeWhy}`); assert.equal(m.lock, 201, `the player's own stake lock was refused: ${m.why}`); }
  } finally { await w.close(); }
});
