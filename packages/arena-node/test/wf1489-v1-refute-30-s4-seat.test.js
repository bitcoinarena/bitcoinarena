// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2068, #1524 (wf1489 v1 refute-30 s4): two honest seats that got the same approvals in another order serve the same chain, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDonationBallots } from '../src/donation-ballots.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 2; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(5);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };
const prop = (by) => { const p = { networkId: NET, serial: 4n, parentSetId: donationSetId(ROOT.recipients), proposer: pk(by),
  recipients: [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3000, label: 'dev b' }, { recipientPk: pk(3), shareBps: 1000, label: 'dev c' }] };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(by))) }; };
const appr = (p, by, h, accept = true) => { const a = { proposalId: donationProposalId(p), atHeight: h, accept, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))); };


test('the approvals behind an approved set are served in one order, whatever order they reached the seat in', async () => {
  const { p, hex } = prop(2);
  const seat = async (order) => {
    const b = createDonationBallots({ db: new DatabaseSync(':memory:'), knownSets: () => [ROOT], verifySecp256k1 });
    assert.equal((await b.add('proposal', hex)).ok, true);
    for (const [by, h] of order) assert.equal((await b.add('approval', appr(p, by, h))).ok, true);
    assert.equal(b.approved().length, 1);
    return b.chainOf(b.approved()[0]);
  };
  const a = await seat([[1, 201], [2, 200]]);
  const b = await seat([[2, 200], [1, 201]]);
  assert.equal(a[0].approvals.length, 2);
  assert.deepEqual(a, b, 'two seats holding the same approvals serve them in the same order');
  assert.equal(a[0].approvals[0], appr(p, 2, 200), 'oldest height first');
});
