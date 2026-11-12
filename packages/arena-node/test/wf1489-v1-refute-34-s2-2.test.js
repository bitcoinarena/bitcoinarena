// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 skeptic 2 (2): an INSIDER - any recipient of the admin key's set, however small its share - fills
// MAX_ROWS (4096) with its own proposals (each serial a new id; none ever approved), and since nothing is ever deleted the
// seat answers 429 to every honest ballot from then on: the developers' ballot is locked for good by one key.
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

test('one recipient filling MAX_ROWS with its own proposals does not lock the other developers out for good', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const junk = (s) => mk(2, rootId, [{ recipientPk: pk(2), shareBps: 10000, label: 'b' + s }], BigInt(4 + s));
  for (let s = 0; s < 3; s++) { const r = await b.add('proposal', junk(s).hex); assert.equal(r.ok && r.fresh, true, JSON.stringify(r)); }
  const ins = db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)');
  for (let s = 3; s < 4096; s++) { const { p, hex } = junk(s); const id = toHex(donationProposalId(p)); ins.run(id, 'proposal', id, hex, Date.now()); }
  const honest = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 5000, label: 'a' }, { recipientPk: pk(2), shareBps: 5000, label: 'b' }], 5n);
  const r = await b.add('proposal', honest.hex);
  assert.equal(r.ok, true, 'dev a (6667 bps) can no longer propose: ' + JSON.stringify(r));
});
