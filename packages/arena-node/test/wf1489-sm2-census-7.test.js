// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 2 (census area), finding 7: THE DEVELOPERS' DONATION BALLOT (donation-ballots.js) is spread
// only by server.js forwardBallot - one fire-and-forget POST /donation-ballot per seat, no retry, no peer pull (config proposals got
// one in #1152, these did not). What a seat refuses on arrival is gone for good: an approval that arrives BEFORE its proposal is 404
// (not kept), a proposal whose parent set this seat has not approved YET is 403 (not kept). Two developers on two nodes forward
// their objects concurrently, so seat B can receive dev 1's approval before dev 2's proposal, or the serial-5 proposal before the
// last approval of serial 4. Every message reaches every seat - only the order differs - and the seats end with different
// approved sets, so different donation sets in force: a round naming the new set is refused at B ("holds no signed donation
// set"), a proposal deposit is checked against different recipients (proposals.js recipientsFor) - seats split for good.
// Fixtures copied from donation-ballots.test.js.
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
const prop = (by, parent, serial, recipients) => { const p = { networkId: NET, serial, parentSetId: donationSetId(parent), proposer: pk(by), recipients };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(by))) }; };
const appr = (p, by, h, accept = true) => { const a = { proposalId: donationProposalId(p), atHeight: h, accept, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))); };
const seat = () => createDonationBallots({ db: new DatabaseSync(':memory:'), knownSets: () => [ROOT], verifySecp256k1 });
const approvedIds = (s) => s.approved().map((x) => `${x.serial}:${toHex(donationSetId(x.recipients))}:${x.validFrom}`).sort();

test('an approval that reaches a seat before its proposal is lost for good: the seats approve different sets', async () => {
  // dev a gives 1000 bps of its own share to dev c: it cuts no other recipient's share, so dev a's 6667 bps approve it alone
  const S4 = [{ recipientPk: pk(1), shareBps: 5667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }, { recipientPk: pk(3), shareBps: 1000, label: 'dev c' }];
  const { p, hex } = prop(1, ROOT.recipients, 4n, S4);
  const a1 = appr(p, 1, 200);          // dev a (6667 bps) approves its own proposal at once, from its own node
  // seat A: proposal first, then the approval (the order its own dev node sent them)
  const A = seat();
  assert.equal((await A.add('proposal', hex)).ok, true);
  assert.equal((await A.add('approval', a1)).ok, true);
  // seat B: the same two objects, the approval's forward first (two concurrent fire-and-forget POSTs)
  const B = seat();
  const early = await B.add('approval', a1);
  assert.equal((await B.add('proposal', hex)).ok, true);
  assert.equal(A.approved().length, 1, 'seat A approves serial 4');
  // the invariant: every message reached both seats, so both hold the same approved sets
  assert.deepEqual(approvedIds(B), approvedIds(A),
    `seat B refused the early approval (${early.status}: ${early.why}) and nothing ever brings it back - serial 4 is in force at A and not at B`);
});

test('a proposal over a just-approved set reaching a seat before that set\'s last approval is lost for good', async () => {
  const S4 = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 4000, label: 'dev b' }];
  const four = prop(2, ROOT.recipients, 4n, S4);
  const S5 = [{ recipientPk: pk(1), shareBps: 5000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 5000, label: 'dev b' }];
  const five = prop(2, S4, 5n, S5);
  const fourYes1 = appr(four.p, 1, 200), fiveYes1 = appr(five.p, 1, 210), fiveYes2 = appr(five.p, 2, 210);
  const A = seat(), B = seat();
  // seat A hears everything in order
  for (const [k, h] of [['proposal', four.hex], ['approval', fourYes1], ['proposal', five.hex], ['approval', fiveYes2], ['approval', fiveYes1]]) assert.equal((await A.add(k, h)).ok, true, `${k} at A`);
  assert.deepEqual(A.approved().map((x) => String(x.serial)), ['4', '5']);
  // seat B: dev a's approval of serial 4 (forwarded by dev a's node) comes in after dev b's serial-5 proposal (forwarded by dev b's node)
  await B.add('proposal', four.hex);
  const lost = await B.add('proposal', five.hex);
  await B.add('approval', fourYes1);
  await B.add('approval', fiveYes2); await B.add('approval', fiveYes1);
  assert.deepEqual(approvedIds(B), approvedIds(A),
    `seat B refused serial 5 (${lost.status}: ${lost.why}) while serial 4 was one approval short, and never takes it again`);
});

test('kanban #2535: a seat that missed every forward takes the same sets from a peer\'s GET /donation-ballots list', async () => {
  const S4 = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 4000, label: 'dev b' }];
  const four = prop(2, ROOT.recipients, 4n, S4);
  const S5 = [{ recipientPk: pk(1), shareBps: 5000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 5000, label: 'dev b' }];
  const five = prop(2, S4, 5n, S5);
  const A = seat(), C = seat();
  for (const [k, h] of [['proposal', four.hex], ['approval', appr(four.p, 1, 200)], ['proposal', five.hex], ['approval', appr(five.p, 2, 210)], ['approval', appr(five.p, 1, 210)]]) assert.equal((await A.add(k, h)).ok, true);
  // what GET /donation-ballots answers, newest first as a peer may send it
  const list = JSON.parse(JSON.stringify(A.list())).reverse();
  assert.equal(await C.pull(list), 5);
  assert.deepEqual(approvedIds(C), approvedIds(A));
  assert.equal(await C.pull(list), 0, 'a second pull takes nothing new');
});
