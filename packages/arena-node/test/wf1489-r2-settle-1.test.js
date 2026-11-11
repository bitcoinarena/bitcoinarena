// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (settle-1): POST /donation-ballot keeps and forwards ANY self-signed donation proposal or approval.
// donation-ballots.js add() checks only that the signature verifies under the key the object itself names (proposer /
// signer) - not that this key is a recipient of a parent set this seat holds. A stranger mints keys at will and every
// proposal is INSERTed into donation_ballots forever, answered `fresh: true` (so server.js forwards it to every seat),
// re-tallied on every add (a full scan + one secp256k1 verify per stored proposal) and listed on GET /donation-ballots.
// Safe: a proposal whose parent set this seat does not hold, or whose proposer is no recipient of it, is not kept and
// not fresh; an approval by a key outside the parent set is not kept.
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
const prop = (by, parentSetId, serial = 4n) => { const p = { networkId: NET, serial, parentSetId, proposer: pk(by),
  recipients: [{ recipientPk: pk(by), shareBps: 10000, label: 'x'.repeat(40) }] };
  return { p, hex: toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(by))) }; };
const appr = (p, by, h) => { const a = { proposalId: donationProposalId(p), atHeight: h, accept: true, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))); };

test('a stranger\'s self-signed donation proposals are not kept, not fresh (not forwarded) and not listed', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  let fresh = 0;
  for (let i = 0; i < 40; i++) {
    // half name a parent set no seat holds, half name the real parent with a proposer outside it
    const parent = i % 2 ? new Uint8Array(32).fill(i) : donationSetId(ROOT.recipients);
    const { hex } = prop(1000 + i, parent, BigInt(4 + i));
    const r = await b.add('proposal', hex);
    if (r.ok && r.fresh) fresh++;
  }
  const kept = db.prepare('SELECT COUNT(*) AS n FROM donation_ballots').get().n;
  assert.equal(fresh, 0, `${fresh} stranger proposals were answered fresh (and so forwarded to every seat)`);
  assert.equal(kept, 0, `${kept} stranger proposals were kept in donation_ballots`);
  assert.equal(b.list().length, 0, 'GET /donation-ballots lists the stranger proposals');
});

test('an approval by a key outside the parent set is not kept', async () => {
  const db = new DatabaseSync(':memory:');
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const { p, hex } = prop(2, donationSetId(ROOT.recipients));   // a real recipient's proposal
  assert.equal((await b.add('proposal', hex)).ok, true);
  let fresh = 0;
  for (let i = 0; i < 20; i++) { const r = await b.add('approval', appr(p, 2000 + i, 200 + i)); if (r.ok && r.fresh) fresh++; }
  const kept = db.prepare("SELECT COUNT(*) AS n FROM donation_ballots WHERE kind = 'approval'").get().n;
  assert.equal(fresh, 0, `${fresh} stranger approvals were answered fresh`);
  assert.equal(kept, 0, `${kept} stranger approvals were kept`);
});
