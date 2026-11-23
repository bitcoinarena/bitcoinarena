// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r21 settle-1: a vote dated before the decision cannot undo an approved, in-force donation set.
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



test('an approved donation set stays approved when its minority proposer later posts a deny backdated below the deciding votes', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  // dev b (33 %) proposes to give 10 % of its own share to a new key; dev a (67 %) keeps its share
  const prop = mk(2, rootId, [{ recipientPk: pk(1), shareBps: 6667, label: 'a' }, { recipientPk: pk(2), shareBps: 2333, label: 'b' }, { recipientPk: pk(3), shareBps: 1000, label: 'c' }], 4n);
  assert.equal((await b.add('proposal', prop.hex)).fresh, true);
  assert.equal((await b.add('approval', appr(prop.p, 2, 300, true))).fresh, true);
  assert.equal((await b.add('approval', appr(prop.p, 1, 301, true))).fresh, true);
  assert.equal(b.approved().length, 1, 'approved by the majority');
  assert.equal(b.approved()[0].validFrom, 302);
  // much later (the set has been in force for many blocks) dev b signs a deny dated at height 10
  const late = await b.add('approval', appr(prop.p, 2, 10, false));
  assert.equal(late.ok && late.fresh, true, 'the seat keeps the backdated vote: ' + JSON.stringify(late));
  assert.equal(b.approved().length, 1, 'a backdated minority vote cannot undo the set the majority put in force at 302 (approved now: ' + b.approved().length + ', state ' + b.list()[0].state + ')');
});
