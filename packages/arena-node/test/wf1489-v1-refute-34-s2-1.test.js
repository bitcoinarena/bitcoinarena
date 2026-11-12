// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 skeptic 2 (1): an INSIDER - the minority recipient of the parent set - fills a proposal's
// MAX_APPROVALS_PER_PROPOSAL (256) with its own approvals (each atHeight a new digest; the tally counts it once), so the
// majority recipient's approval is answered 429 and a proposal the parent set would approve can never be approved.
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

test('a minority recipient flooding its own approvals does not lock the majority approval out', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  // dev a (6667) proposes to add dev c, without cutting dev b: needs only dev a's own accept (> half)
  const prop = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 5667, label: 'a' }, { recipientPk: pk(2), shareBps: 3333, label: 'b' }, { recipientPk: pk(3), shareBps: 1000, label: 'c' }], 4n);
  assert.equal((await b.add('proposal', prop.hex)).ok, true);
  const pid = toHex(donationProposalId(prop.p));
  // dev b (3333) denies, then sends more approvals at other heights through add() itself: each one kept, answered fresh
  for (let h = 200; h < 203; h++) { const r = await b.add('approval', appr(prop.p, 2, h, false)); assert.equal(r.ok && r.fresh, true, JSON.stringify(r)); }
  // ... up to the cap (the same rows add() writes, inserted directly only to keep the test fast)
  const ins = db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)');
  for (let h = 203; h < 200 + 256; h++) { const hex = appr(prop.p, 2, h, false); ins.run(toHex(donationApprovalDigest({ proposalId: donationProposalId(prop.p), atHeight: h, accept: false, signer: pk(2) })), 'approval', pid, hex, Date.now()); }
  const r = await b.add('approval', appr(prop.p, 1, 500, true));
  assert.equal(r.ok, true, 'dev a (6667 bps) cannot approve: ' + JSON.stringify(r));
  assert.equal(b.list()[0].state, 'approved');
});
