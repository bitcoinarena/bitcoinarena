// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r40 entry 1: the #2069 fee-lock anchor ("a claimed entry counts for a fee lock only when this seat holds a verified
// stake lock at its stake outpoint for an entry of the same stake point", stake-lock-signer-node.js claimFits) is met by ANY entry of that stake
// point - also the attacker's own, under his own player key. The attacker stakes his own entry A (key k_a, stake point P' = p'G, his own lock),
// then posts a copy C of the victim's public entry under the victim's player key with stake point P', A's stake outpoint, the victim's fee
// outpoint and F, and a claim by p' (an id ground below the victim's). C's claim fits the victim's fee lock; the victim's own claim does not
// yet (its stake lock is not held - the page hands it in parallel with the fee lock, after the federation accepted both). C takes the
// victim's fee lock at every seat, and the victim's own stake lock is then refused at every seat ("another entry of that player key is
// already staked"): the victim never plays, its sats wait for the lock expiry. Safe: the victim's own entry is staked and seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { feldmanGroup } from '../src/curve.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489-r40-entry-1 an attacker\'s own staked entry anchors a copy\'s claim on the victim\'s fee lock: the victim is never staked', async () => {
  const w = await lockRound({ n: 3 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // THE VICTIM: handout, entry and claim at every seat, its locks in the federation, not yet handed (the page hands them right after)
    const vkey = b32(0x61);
    const victim = await lockAndPlay(w, player('victim', 0x61), { noMarks: true, only: [] });
    const vfee = { paymentImage: { kind: 'hash', bytes: sha256(victim.entry.feePreimage) }, amountMsat: victim.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(vkey), expiration: victim.fields.expiration };
    for (const d of w.nodes) assert.ok(d.round.lockClaim(victim.eid), 'precondition: the victim\'s claim is kept at every seat');
    // THE ATTACKER'S OWN ENTRY A: his key, his stake point P', his own stake and fee lock (real money, his own, back to him)
    const akey = b32(0x62);
    const pre = secretScalar();
    const deal = async (playerPubkey) => {
      const e = rand(32);
      const dealt = await dealHandout({ preimage: pre, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey,
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed || 2, curve: feldmanGroup });
      assert.equal(dealt.ok, true, dealt.why);
      return dealt.handout;
    };
    const ha = await deal(akey);
    const aF = rand(32);
    const A = { ...victim.entry, playerPubkey: akey, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: sha256(pre),
      vssSharesRef: handoutId(ha), stakePoint: ha.commitments[0], feePreimage: aF,
      stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: rand(32), outIdx: 1n } };
    const aid = entryId(A);
    const aStake = { paymentImage: { kind: 'point', bytes: A.stakePoint }, amountMsat: netStakeMsat(A), claimPk: w.claimPk, refundPk: refundKeyOf(akey), expiration: victim.fields.expiration };
    const aFee = { paymentImage: { kind: 'hash', bytes: sha256(aF) }, amountMsat: A.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(akey), expiration: victim.fields.expiration };
    await w.port.put(A.stakeLockOutpoint, aStake);
    await w.port.put(A.feeLockOutpoint, aFee);
    // THE COPY C: the victim's key, F and fee outpoint; stake point P' and A's stake outpoint; an id below the victim's
    const hc = await deal(vkey);
    let C, cid;
    for (;;) {
      C = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: sha256(pre),
        vssSharesRef: handoutId(hc), stakePoint: hc.commitments[0], stakeLockOutpoint: A.stakeLockOutpoint };
      cid = entryId(C);
      if (Buffer.compare(Buffer.from(cid), Buffer.from(victim.eid)) < 0) break;
    }
    const facts = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', body }); return `${r.status} ${(await r.text()).slice(0, 90)}`; };
      const f = { seat: d.port };
      f.aHandout = await post('/handout', encodeHandout(ha));
      f.aEntry = await post('/entry', encodeEntryContract(A));
      f.aClaim = await post(`/lock-claim?entry=${toHex(aid)}`, schnorr.sign(lockClaimDigest(aid), pre));
      f.aLock = await post(`/lock?entry=${toHex(aid)}`, JSON.stringify(lockFieldsToJson(aStake)));
      f.aFee = await post(`/fee-lock?entry=${toHex(aid)}`, JSON.stringify(lockFieldsToJson(aFee)));
      f.cHandout = await post('/handout', encodeHandout(hc));
      f.cEntry = await post('/entry', encodeEntryContract(C));
      f.cClaim = await post(`/lock-claim?entry=${toHex(cid)}`, schnorr.sign(lockClaimDigest(cid), pre));
      f.cFee = await post(`/fee-lock?entry=${toHex(cid)}`, JSON.stringify(lockFieldsToJson(vfee)));
      facts.push(f);
    }
    // THE VICTIM'S PAGE HANDS ITS TWO LOCKS NOW, AT EVERY SEAT
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const [l, fe] = await Promise.all([
        fetch(`${base}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) }),
        fetch(`${base}/fee-lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(vfee)) })]);
      const f = facts.find((x) => x.seat === d.port);
      f.vLock = `${l.status} ${(await l.text()).slice(0, 110)}`; f.vFee = `${fe.status} ${(await fe.text()).slice(0, 110)}`;
      f.aSeen = !!d.round.stakeSeen(aid); f.copyHoldsVictimFee = !!d.round.feeLock(cid);
      f.victimStake = !!d.round.stakeLock(victim.eid); f.victimSeen = !!d.round.stakeSeen(victim.eid);
    }
    console.log('  FACTS #1489-r40-entry-1:', JSON.stringify(facts, null, 1));
    for (const f of facts) assert.ok(f.aSeen, `precondition: the attacker's own entry is staked (${f.aLock} / ${f.aFee})`);
    for (const f of facts) assert.equal(f.copyHoldsVictimFee, false, `a copy anchored by the attacker's own stake lock holds the victim's fee lock (copy /fee-lock ${f.cFee})`);
    for (const f of facts) assert.equal(f.victimStake && f.victimSeen, true,
      `the victim's own entry is not staked at seat ${f.seat}: /lock ${f.vLock}; /fee-lock ${f.vFee}`);
  } finally { await w.close(); }
});
