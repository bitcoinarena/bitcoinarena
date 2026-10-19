// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PUBLISHER NAMES THE SET THE DEVELOPERS APPROVED (§27A.4.1, kanban #382): the duty and grid runners read a seat's ballots and
// tally them themselves, so their new rounds name the approved split from its block on - and a seat that does not answer
// leaves the last tally standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createApprovedSets } from '../src/approved-sets.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetInForce } from '../../arena-protocol/src/authority.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 5; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(8);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };
const NEW = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 4000, label: 'dev b' }];
const P = { networkId: NET, serial: 4n, parentSetId: donationSetId(ROOT.recipients), proposer: pk(2), recipients: NEW };
const pHex = toHex(encodeDonationProposal(P)) + toHex(secp256k1.sign(donationProposalId(P), sk(2)));
const A = { proposalId: donationProposalId(P), atHeight: 500, accept: true, signer: pk(1) };
const aHex = toHex(encodeDonationApproval(A)) + toHex(secp256k1.sign(donationApprovalDigest(A), sk(1)));
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };

test('the runner\'s tally: an approved split is in force for its census heights from 501 on; a silent seat keeps the last tally', async () => {
  let up = true;
  const fetcher = async () => { if (!up) throw new Error('down'); return new Response(JSON.stringify({ ballots: [{ hex: pHex, approvals: [aHex] }] })); };
  const a = createApprovedSets({ seatUrl: 'http://seat', known: [ROOT], verifySecp256k1, fetcher });
  assert.deepEqual(await a.refresh(), { ok: true, sets: 1, ballots: 1 });
  const at = (height) => donationSetInForce({ networkId: NET, authority: new Uint8Array(32), recovery: new Uint8Array(32).fill(1), sets: [ROOT], height,
    verify: (sig) => true, approved: a.sets() });
  assert.equal(toHex(donationSetId(at(500).recipients)), toHex(donationSetId(ROOT.recipients)), 'before the approval\'s block: the admin key\'s set');
  assert.equal(toHex(donationSetId(at(501).recipients)), toHex(donationSetId(NEW)), 'from block 501: the approved split');
  up = false;
  assert.equal((await a.refresh()).ok, false);
  assert.equal(a.sets().length, 1, 'kept');
});
