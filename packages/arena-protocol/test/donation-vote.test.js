// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' OWN BALLOT (§27A.4.1): a recipient proposes a new split, the parent set's recipients accept or
// deny, and the proposal is a set in force from the block after the approval that took the accepting share above half - for
// new rounds only, the network id unchanged. the owner's example: 66.67 / 33.33 -> 60 / 20 / 10 (+10 to a newcomer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { donationProposalId, donationApprovalDigest, encodeDonationProposal, decodeDonationProposal, encodeDonationApproval,
  decodeDonationApproval, tallyDonationProposal, approvedDonationSets } from '../src/donation-vote.js';
import { donationSetInForce } from '../src/authority.js';
import { donationSetId } from '../src/donation.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 1; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const sign = (digest, n) => secp256k1.sign(digest, sk(n));
const verifySecp256k1 = (sig, digest, key) => secp256k1.verify(sig, digest, key);
const NET = new Uint8Array(32).fill(7);
const PARENT = [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }];
const NEW = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3000, label: 'dev b' }, { recipientPk: pk(3), shareBps: 1000, label: 'dev c' }];
const proposal = (by = 2, recipients = NEW, serial = 4n) => {
  const p = { networkId: NET, serial, parentSetId: donationSetId(PARENT), proposer: pk(by), recipients };
  return { ...p, signature: sign(donationProposalId(p), by) };
};
const approval = (p, by, atHeight, accept = true) => {
  const a = { proposalId: donationProposalId(p), atHeight, accept, signer: pk(by) };
  return { ...a, signature: sign(donationApprovalDigest(a), by) };
};

test('proposal and approval bytes round-trip', () => {
  const p = proposal();
  const d = decodeDonationProposal(encodeDonationProposal(p));
  assert.equal(d.serial, 4n); assert.deepEqual(d.recipients.map((r) => r.shareBps), [6000, 3000, 1000]);
  const a = approval(p, 1, 156760, false);
  assert.deepEqual(decodeDonationApproval(encodeDonationApproval(a)).accept, false);
});

test('approved once the accepting recipients hold more than half: dev a alone (66.67 %) is enough; from the next block on', async () => {
  const p = proposal(2);
  const open = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 2, 156760)], parent: PARENT, verifySecp256k1 });
  assert.equal(open.state, 'open'); assert.equal(open.acceptBps, 3333, 'dev b\'s 33.33 % is not more than half');
  const t = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 2, 156760), approval(p, 1, 156762)], parent: PARENT, verifySecp256k1 });
  assert.equal(t.state, 'approved'); assert.equal(t.validFrom, 156763); assert.equal(t.acceptBps, 10000);
});

test('exactly half is not more than half; half denying refuses it', async () => {
  const half = [{ recipientPk: pk(1), shareBps: 5000, label: 'a' }, { recipientPk: pk(2), shareBps: 5000, label: 'b' }];
  const p0 = { networkId: NET, serial: 4n, parentSetId: donationSetId(half), proposer: pk(1), recipients: NEW };
  const p = { ...p0, signature: sign(donationProposalId(p0), 1) };
  assert.equal((await tallyDonationProposal({ proposal: p, approvals: [approval(p, 1, 10)], parent: half, verifySecp256k1 })).state, 'open');
  assert.equal((await tallyDonationProposal({ proposal: p, approvals: [approval(p, 1, 10), approval(p, 2, 11, false)], parent: half, verifySecp256k1 })).state, 'refused');
});

test('what is not counted: a stranger, a forged signature, a second vote, a proposer outside the set', async () => {
  const p = proposal(2);
  const forged = { ...approval(p, 1, 156760), signature: sign(new Uint8Array(32), 1) };
  const t = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 9, 156759), forged, approval(p, 2, 156761), approval(p, 2, 156762, false)], parent: PARENT, verifySecp256k1 });
  assert.equal(t.state, 'open'); assert.equal(t.acceptBps, 3333);
  assert.equal(t.refused.length, 3, t.refused.join('; '));
  const outsider = proposal(9);
  assert.equal((await tallyDonationProposal({ proposal: outsider, approvals: [], parent: PARENT, verifySecp256k1 })).state, 'refused');
});

test('in force for new rounds only: before validFrom the parent, from it the approved split; the admin key\'s higher serial still wins', async () => {
  const p = proposal(2);
  const known = [{ networkId: NET, serial: 3n, validFrom: 156038, recipients: PARENT }];
  const { sets } = await approvedDonationSets({ networkId: NET, known, ballots: [{ proposal: p, approvals: [approval(p, 1, 156762)] }], verifySecp256k1 });
  assert.equal(sets.length, 1); assert.equal(sets[0].validFrom, 156763);
  const authority = new Uint8Array(32), recovery = new Uint8Array(32).fill(1);
  const inForce = (height, extra = []) => donationSetInForce({ networkId: NET, authority, recovery, sets: extra, height, verify: () => false, approved: [...sets] });
  assert.equal(inForce(156762).ok, false, 'no admin set given here: before validFrom nothing approved is in force');
  const now = inForce(156763);
  assert.equal(now.ok, true); assert.equal(now.serial, 4n); assert.deepEqual(now.recipients.map((r) => r.shareBps), [6000, 3000, 1000]);
  assert.ok(now.approvedBy);
});

test('a proposer who denies their own proposal withdraws it: refused, whoever has not voted yet (2026-10-22: "This is no longer open")', async () => {
  const p = proposal(2);
  const t = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 2, 157289, false)], parent: PARENT, verifySecp256k1 });
  assert.deepEqual([t.state, t.why, t.denyBps], ['refused', 'withdrawn by its proposer', 3333]);
  const late = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 2, 157289, false), approval(p, 1, 157290)], parent: PARENT, verifySecp256k1 });
  assert.equal(late.state, 'refused', 'an acceptance after the withdrawal changes nothing');
  const other = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 1, 157289, false)], parent: PARENT, verifySecp256k1 });
  assert.equal(other.state, 'refused', 'dev a (66.67 %) denying refuses it as before');
  const before = await tallyDonationProposal({ proposal: p, approvals: [approval(p, 1, 157288), approval(p, 2, 157289, false)], parent: PARENT, verifySecp256k1 });
  assert.equal(before.state, 'approved', 'approved before the proposer turned on it stays approved');
});
