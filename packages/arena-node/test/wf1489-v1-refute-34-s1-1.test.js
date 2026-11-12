// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #1528 (1): add() refuses new stranger rows, but the rows a stranger got kept before the fix stay kept,
// listed on GET /donation-ballots, re-tallied on every add and counted against MAX_ROWS (4096 of them lock honest ballots out, 429)
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

test('V5 reload: rows a stranger got kept before the fix are still listed after the upgrade', async () => {
  const db = new DatabaseSync(':memory:');
  createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  // what a pre-#1528 seat stored for a stranger (exactly what its add() inserted)
  for (let i = 0; i < 5; i++) {
    const { p, hex } = mk(1000 + i, rootId, [{ recipientPk: pk(1000 + i), shareBps: 10000, label: 'x' }], BigInt(4 + i));
    const id = toHex(donationProposalId(p));
    db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, 'proposal', id, hex, i);
  }
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  await b.retally();
  assert.equal(b.list().length, 0, `GET /donation-ballots still lists ${b.list().length} stranger proposals kept before the fix`);
});

test('kanban #1710, #1775: 4096 stranger rows kept before the fix do not lock an honest dev ballot out (no 429)', async () => {
  const db = new DatabaseSync(':memory:');
  createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const { p, hex } = mk(1000, rootId, [{ recipientPk: pk(1000), shareBps: 10000, label: 'x' }], 4n);
  const stmt = db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)');
  const pid = toHex(donationProposalId(p));
  stmt.run(pid, 'proposal', pid, hex, 0);
  for (let i = 0; i < 4095; i++) stmt.run('a' + i, 'approval', pid, appr(p, 2000 + i, 200 + i), i + 1);
  const b = createDonationBallots({ db, knownSets: () => [ROOT], verifySecp256k1 });
  const honest = mk(1, rootId, [{ recipientPk: pk(1), shareBps: 5000, label: 'a' }, { recipientPk: pk(2), shareBps: 5000, label: 'b' }], 5n);
  const r = await b.add('proposal', honest.hex);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(b.list().map((x) => x.id), [toHex(donationProposalId(honest.p))]);
});
