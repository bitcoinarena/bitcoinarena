// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state audit 2026-11-27 sm1-entry 5: claimTakesBack (stake-lock-signer-node.js, #1603) lets go of the HOLDER's stake and fee
// locks BEFORE the claimed entry's own lock is verified. verifyStakeLock evaluates it in the first "one lock is one entry" guard, before the
// federation is asked and before lockFieldsMatchEntry. The claim fits by the copy's OWN stake point (claimFits, kind 'stake'), so a stranger's
// copy of a staked entry - the player's key and stake outpoint, his own handout and stake point P', his own claim by p' - is "claimed" and the
// honest holder (whose claim is under P, which does not fit P') is not. Its rows go (round.yieldEntryLocks), then the copy is refused because
// the lock's image is P, not P'. The honest entry, staked and seen at every seat, is unstaked by one refused POST /lock per seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { feldmanGroup } from '../src/curve.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489-sm1-entry-5 a refused copy\'s POST /lock unstakes the honest, claimed, staked entry it copies', async () => {
  const w = await lockRound({ n: 3 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const victim = await lockAndPlay(w, player('victim', 0x61), { noMarks: true });
    for (const d of w.nodes) assert.ok(d.round.stakeSeen(victim.eid), 'precondition: the victim is staked at every seat');
    for (const d of w.nodes) assert.ok(d.round.lockClaim(victim.eid), 'precondition: the victim\'s claim is kept at every seat');
    // THE STRANGER: his own stake secret and handout under the victim's player key, a copy naming the victim's lock outpoints
    const pre = secretScalar(), e = rand(32);
    const dealt = await dealHandout({ preimage: pre, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: victim.entry.playerPubkey,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed || 2, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(pre), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0] };
    const cid = entryId(copy);
    const facts = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const h = await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) }); await h.text();
      const en = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); const enw = (await en.text()).slice(0, 100);
      const c = await fetch(`${base}/lock-claim?entry=${toHex(cid)}`, { method: 'POST', body: schnorr.sign(lockClaimDigest(cid), pre) }); await c.text();
      const l = await fetch(`${base}/lock?entry=${toHex(cid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      facts.push({ handout: h.status, entry: en.status, enw, claim: c.status, lock: l.status, why: (await l.text()).slice(0, 140),
        victimSeen: !!d.round.stakeSeen(victim.eid), victimLock: !!d.round.stakeLock(victim.eid), copyLock: !!d.round.stakeLock(cid) });
    }
    console.log('  FACTS #1489-sm1-entry-5:', JSON.stringify(facts));
    for (const f of facts) assert.equal(f.copyLock, false, 'the copy is staked by the victim\'s lock');
    for (const f of facts) assert.equal(f.victimLock && f.victimSeen, true,
      `the honest entry lost its stake lock / seen row to a copy whose own lock was refused (copy's /lock ${f.lock}: ${f.why})`);
  } finally { await w.close(); }
});
