// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 skeptic 3 (2): the per-signer caps leave out every proposal tallied 'approved', and retally tallies a
// proposal against a parent found by its recipients alone - across networks. The majority recipient names a network no
// seat holds (any 32 bytes): each proposal is never a set anywhere, yet it tallies approved and is never counted against a cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDonationBallots } from '../src/donation-ballots.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n & 0xff; b[30] = n >> 8; b[0] = 2; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(5);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };
const mk = (by, parentSetId, recipients, serial, net = NET) => { const p = { networkId: net, serial, parentSetId, proposer: pk(by), recipients };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(by))) }; };
const appr = (p, by, h, accept = true) => { const a = { proposalId: donationProposalId(p), atHeight: h, accept, signer: pk(by) };
  return { id: toHex(donationApprovalDigest(a)), hex: toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))) }; };
const rootId = donationSetId(ROOT.recipients);
// serial 3 = the parent's own serial: never above it, so never a set in force - but its tally is 'approved'

test('a self-accepted proposal for a network no seat holds is counted against its proposer\'s room', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  let kept = 0;
  for (let s = 0; s < 30; s++) {
    const net = new Uint8Array(32).fill(0x40); net[0] = s;   // a fresh made-up network each time, serial 4 above the parent's 3
    const { p, hex } = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], 4n, net);
    const r1 = await b.add('proposal', hex);
    if (!(r1.ok && r1.fresh)) continue;
    const r2 = await b.add('approval', appr(p, 1, 200 + s).hex);
    if (r2.ok && r2.fresh) kept++;
  }
  assert.equal(b.approved().length, 0, 'none is a set in force on any network this seat holds');
  const listed = b.list();
  assert.ok(kept <= 8, `dev a kept ${kept} of 30 proposals for made-up networks (open cap 8), listed: ${listed.length}, states ${[...new Set(listed.map((x) => x.state))]}`);
});
