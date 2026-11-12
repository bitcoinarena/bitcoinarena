// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 skeptic 3 (1): the per-signer caps (#1899, #1939) leave out every proposal whose tally is
// 'approved' - but retally's tally checks neither the serial (not above the parent's) nor the network, so a proposal that is
// never a set in force still tallies 'approved'. The recipient holding more than half the share (6667 of the spec's 66/33
// set) accepts its own proposals and so keeps any number of rows: every one re-read and re-tallied on each add, forwarded to
// every seat, and none of them ever counted against MAX_KEPT_PER_PROPOSER (256) or MAX_OPEN_PER_PROPOSER (8).
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
const junk = (s) => mk(1, rootId, [{ recipientPk: pk(1), shareBps: 6667, label: 'a' + s }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], 3n);

test('the majority recipient cannot keep unbounded rows by accepting its own proposals that never become a set', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  // through add(), one after another: 20 proposals, each accepted by its own proposer - far past MAX_OPEN_PER_PROPOSER (8)
  let kept = 0;
  for (let s = 0; s < 20; s++) {
    const { p, hex } = junk(s);
    const r1 = await b.add('proposal', hex);
    if (!(r1.ok && r1.fresh)) continue;
    const r2 = await b.add('approval', appr(p, 1, 200 + s).hex);
    if (r2.ok && r2.fresh) kept++;
  }
  // the same, written straight to the table up to 400 (to keep the test short), then add() is asked once more
  const ins = db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)');
  for (let s = 20; s < 400; s++) { const { p, hex } = junk(s); const id = toHex(donationProposalId(p)); ins.run(id, 'proposal', id, hex, Date.now());
    const a = appr(p, 1, 200 + s); ins.run(a.id, 'approval', id, a.hex, Date.now()); }
  await b.retally();
  const last = junk(400);
  const r = await b.add('proposal', last.hex);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM donation_ballots').get().n;
  assert.equal(b.approved().length, 0, 'none of them is a set in force');
  assert.ok(kept <= 8, `dev a kept ${kept} of 20 self-accepted proposals through add() (open cap 8)`);
  assert.equal(r.ok, false, `with ${rows} rows of its own (${b.list().length} proposals listed, all 'approved' by its own vote, none in force), dev a's next proposal is still kept: ${JSON.stringify(r)}`);
});
