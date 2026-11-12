// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-entry: one PLAY of a page as the seats see it, for the wf1489-sm2-entry tests.
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, b32, playFor, warmPlay } from './window-fixture.js';
import { dealHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { entryId } from '../../arena-protocol/src/contracts.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { pluginForRound } from '../src/plugins.js';
import { sha256 } from '../../arena-protocol/src/hash.js';

// AN ATTEMPT AS THE PAGE MAKES IT: a handout, an entry naming it, a stake lock and a fee lock in the federation (lock-round-fixture lockAndPlay's shapes)
export async function attempt(w, who) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar(), e = rand(32), feeSecret = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: w.needed, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  await warmPlay(who, w.randomness);
  const play = playFor(who, w.randomness);
  const f = pluginForRound(w.c, w.nodes[0].round.plugins);
  const outpoint = { txid: rand(32), outIdx: 0n }, feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = { roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage),
    stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat, f.ok ? entryFeeBpsOf(f.plugin.manifest) : undefined), donationMsat: 0n, joinTick: 0,
    worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: feeSecret,
    stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint, claimKeyAttestationRef: b32(0x9a) };
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  await w.port.put(feeOutpoint, feeFields);
  return { handout: dealt.handout, hid: handoutId(dealt.handout), entry, eid: entryId(entry), outpoint, feeOutpoint, fields, feeFields };
}

