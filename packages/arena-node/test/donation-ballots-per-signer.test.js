// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1899, #1939 (refute of #1528): the donation ballot caps are per signer - repeat approvals, open proposals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDonationBallots } from '../src/donation-ballots.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_TESTNET4 } from '../../arena-protocol/src/test-donation-sets.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n & 0xff; b[30] = n >> 8; b[0] = 2; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(5);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };
const mk = (by, parentSetId, recipients, serial = 4n, net = NET, signBy = by) => { const p = { networkId: net, serial, parentSetId, proposer: pk(by), recipients };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(signBy))) }; };
const appr = (p, by, h, accept = true, signBy = by) => { const a = { proposalId: donationProposalId(p), atHeight: h, accept, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(signBy))); };
const rootId = donationSetId(ROOT.recipients);


// kanban #1899, #1939: every limit is the signer's own
test('repeat approvals: only the first vote is read, a retry is fresh:false, past the per-signer room a later one is not kept', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const prop = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 5667, label: 'a' }, { recipientPk: pk(2), shareBps: 3333, label: 'b' }, { recipientPk: pk(3), shareBps: 1000, label: 'c' }], 4n);
  await b.add('proposal', prop.hex);
  for (let h = 300; h < 308; h++) assert.equal((await b.add('approval', appr(prop.p, 2, h, false))).fresh, true);
  const retry = await b.add('approval', appr(prop.p, 2, 303, false));
  assert.deepEqual([retry.ok, retry.fresh], [true, false]);
  const later = await b.add('approval', appr(prop.p, 2, 400, false));
  assert.deepEqual([later.ok, later.fresh], [true, false], JSON.stringify(later));
  const earlier = await b.add('approval', appr(prop.p, 2, 200, false));
  assert.equal(earlier.status, 429, JSON.stringify(earlier));
  assert.equal(b.list()[0].approvals.length, 1);
  assert.equal(b.list()[0].votes[0].atHeight, 300);
  assert.equal((await b.add('approval', appr(prop.p, 1, 500, true))).fresh, true);
  assert.equal(b.list()[0].state, 'approved');
});

test('open proposals are capped per proposer: the flooder is stopped, another recipient is not, a withdrawal frees room', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const junk = (s) => mk(2, rootId, [{ recipientPk: pk(2), shareBps: 10000, label: 'b' + s }], BigInt(10 + s));
  for (let s = 0; s < 8; s++) assert.equal((await b.add('proposal', junk(s).hex)).fresh, true);
  assert.equal((await b.add('proposal', junk(8).hex)).status, 429);
  assert.equal((await b.add('proposal', junk(0).hex)).fresh, false);   // a retry of a kept one is no 429
  const honest = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 5000, label: 'a' }, { recipientPk: pk(2), shareBps: 5000, label: 'b' }], 5n);
  assert.equal((await b.add('proposal', honest.hex)).fresh, true);
  assert.equal((await b.add('approval', appr(junk(0).p, 2, 300, false))).fresh, true);   // dev b withdraws one of its own
  assert.equal((await b.add('proposal', junk(8).hex)).fresh, true);
});
