// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' BALLOTS A SEAT KEEPS (§27A.4.1): kept only when signed by a recipient of the parent set, tallied
// against the admin key's set, approved once more than half accepted - and the chain behind an approved set, for the page.
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

test('kept, tallied, approved at more than half, and the chain back to the admin key\'s set', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const { p, hex } = prop(2);
  assert.equal((await b.add('approval', appr(p, 1, 200))).status, 404, 'an approval before its proposal is not kept');
  const r = await b.add('proposal', hex);
  assert.equal(r.ok, true); assert.equal(r.fresh, true);
  assert.equal((await b.add('proposal', hex)).fresh, false, 'the same proposal twice is kept once');
  assert.equal((await b.add('proposal', hex.slice(0, -2) + '00')).ok, false, 'a broken signature is refused');
  await b.add('approval', appr(p, 2, 200));
  assert.equal(b.list()[0].state, 'open'); assert.equal(b.approved().length, 0);
  await b.add('approval', appr(p, 1, 201));
  const l = b.list()[0];
  assert.equal(l.state, 'approved'); assert.equal(l.validFrom, 202); assert.equal(l.votes.length, 2);
  assert.equal(b.approved().length, 1); assert.deepEqual(b.approved()[0].recipients.map((x) => x.shareBps), [6000, 3000, 1000]);
  const chain = b.chainOf(b.approved()[0]);
  assert.equal(chain.length, 1); assert.equal(chain[0].proposal, hex); assert.equal(chain[0].approvals.length, 2);
  // a fresh seat reading the same store tallies the same
  const b2 = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  await b2.retally();
  assert.equal(b2.approved()[0].validFrom, 202);
});

test('a proposer outside the set is kept nowhere useful: refused by the tally', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const { hex } = prop(9);
  await b.add('proposal', hex);
  assert.equal(b.list()[0].state, 'refused');
});
