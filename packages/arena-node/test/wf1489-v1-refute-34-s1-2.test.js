// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 (2): a proposal naming an LNURL set this seat holds (testnet4 serials 1/2, regtest) as parent
// makes add() throw (toHex(r.recipientPk) of an LNURL entry, undefined) - a 500 from POST /donation-ballot, not the 403 the fix means
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
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM donation_ballots').get().n;
const rootId = donationSetId(ROOT.recipients);

test('V3 parent an LNURL set (testnet4 serial 1) and the real key set: stranger refused with a status, not a throw', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [TESTNET4_DONATION_SET_KEYS, TEST_DONATION_SET_TESTNET4], verifySecp256k1 });
  for (const parent of [TEST_DONATION_SET_TESTNET4, TESTNET4_DONATION_SET_KEYS]) {
    const id = donationSetId(parent.recipients);
    let r; try { r = await b.add('proposal', mk(904, id, [{ recipientPk: pk(904), shareBps: 10000, label: 'x' }], 9n, parent.networkId).hex); }
    catch (e) { r = { threw: e.message }; }
    assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.status, 403, JSON.stringify(r));
  }
  assert.equal(count(db), 0);
});
