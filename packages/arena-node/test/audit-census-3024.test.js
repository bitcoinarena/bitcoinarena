// kanban #3024: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit census r2 #1 (P11 gap in the #2535 fix): an object that came too early is parked, but park() only checks the
// signature under the key the object itself names - not that the key is a recipient of any held set. A stranger posts
// 1024 self-signed approvals of made-up proposals to POST /donation-ballot; each is parked (404), and the oldest parked
// object - a developer's genuine early approval - is pushed out. When its proposal arrives the vote is not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDonationBallots } from '../src/donation-ballots.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n & 0xff; b[30] = (n >> 8) & 0xff; b[0] = 2; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(5);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };
const prop = (by) => { const p = { networkId: NET, serial: 4n, parentSetId: donationSetId(ROOT.recipients), proposer: pk(by),
  recipients: [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3000, label: 'dev b' }, { recipientPk: pk(3), shareBps: 1000, label: 'dev c' }] };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(by))) }; };
const apprOf = (proposalId, by, h) => { const a = { proposalId, atHeight: h, accept: true, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))); };

test('control: a developer\'s early approval is parked and counted once its proposal arrives', async () => {
  const b = createDonationBallots({ db: new DatabaseSync(':memory:'), knownSets: () => [ROOT], verifySecp256k1 });
  const { p, hex } = prop(2);
  const early = await b.add('approval', apprOf(donationProposalId(p), 1, 200));
  assert.equal(early.parked, true);
  await b.add('proposal', hex);
  assert.equal(b.list()[0].votes.length, 1);
});

test('a stranger\'s self-signed junk does not push a developer\'s parked approval out', async () => {
  const b = createDonationBallots({ db: new DatabaseSync(':memory:'), knownSets: () => [ROOT], verifySecp256k1 });
  const { p, hex } = prop(2);
  const early = await b.add('approval', apprOf(donationProposalId(p), 1, 200));   // dev a's accept reaches this seat first
  assert.equal(early.parked, true);
  // the stranger: fresh keys (no recipient of anything), approvals of made-up proposal ids - each answered 404 and parked
  let parked = 0;
  for (let i = 0; i < 1024; i++) {
    const fake = new Uint8Array(32); fake[0] = 0xee; fake[1] = i & 0xff; fake[2] = i >> 8;
    const r = await b.add('approval', apprOf(fake, 1000 + i, 1));
    if (r.parked) parked++;
  }
  console.log(`MEASURED stranger objects parked: ${parked} of 1024`);
  await b.add('proposal', hex);                                                   // the proposal arrives
  const votes = b.list()[0].votes.length;
  console.log(`MEASURED votes counted for the proposal: ${votes}`);
  assert.equal(votes, 1, 'the developer\'s parked approval was pushed out by a stranger\'s unsigned-for-anything junk: its vote is lost at this seat');
});

