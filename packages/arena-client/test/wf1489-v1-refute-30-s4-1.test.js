// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute-30 s4 (kanban #1524): HONEST SEATS THAT SERVE THE SAME APPROVED SET IN DIFFERENT BYTES STILL REFUSE EVERY PAID JOIN.
// fetchDonationSet groups the seats' /donation-set answers by their raw bytes and takes a group served by at least half of the nodes.
// An approved set (§27A.4.1) is served as JSON whose approvals each seat lists in the order they reached IT
// (donation-ballots.js rows() ORDER BY at_ms, chainOf) and only as far as gossip has reached it. Every seat serves a valid proof of the
// SAME set, yet no byte group reaches half, so the read is refused: "the signer nodes of this round serve different donation sets".
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { fetchDonationSet } from '../src/donation-pay.js';
import { encodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 3; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(4);
const authSk = ed25519.utils.randomSecretKey();
const keys = { authority: ed25519.getPublicKey(authSk), recovery: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
const verifyEd25519 = (s, m, k) => ed25519.verify(s, m, k);
const verifySecp256k1 = (s, d, k) => { try { return secp256k1.verify(s, d, k); } catch { return false; } };
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }] };
ROOT.signature = ed25519.sign(donationSetBodyId(ROOT), authSk);
const rootHex = toHex(encodeDonationSetBody(ROOT)) + toHex(ROOT.signature);
const NEW = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3000, label: 'dev b' }, { recipientPk: pk(3), shareBps: 1000, label: 'dev c' }];
const P = { networkId: NET, serial: 4n, parentSetId: donationSetId(ROOT.recipients), proposer: pk(2), recipients: NEW };
const pHex = toHex(encodeDonationProposal(P)) + toHex(secp256k1.sign(donationProposalId(P), sk(2)));
const ADMIN4 = { networkId: NET, serial: 4n, validFrom: 100, recipients: NEW };
ADMIN4.signature = ed25519.sign(donationSetBodyId(ADMIN4), authSk);
const adminHex = toHex(encodeDonationSetBody(ADMIN4)) + toHex(ADMIN4.signature);
const ap = (by, h) => { const a = { proposalId: donationProposalId(P), atHeight: h, accept: true, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(by))); };
const round = { networkId: NET, donationSetId: donationSetId(NEW), censusHeight: 300, gameId: NEXTBLOCK_GAME_ID, id: new Uint8Array(32).fill(9) };
// three honest seats' answers for the same approved set: dev a's approval alone (66.67 % > half) carries it; dev b's arrived later, or
// earlier, or not yet - each seat lists what it holds in the order it got it
const FORMS = [
  { approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(1, 201)] }], admin: adminHex },
  { approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(1, 201), ap(2, 200)] }], admin: adminHex },
  { approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(2, 200), ap(1, 201)] }], admin: adminHex },
];
const serving = (formOf) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
  if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
  return new Response(JSON.stringify(FORMS[formOf(u.host)]), { status: 200, headers: { 'content-type': 'application/json' } });
};
const nodes = (n) => Array.from({ length: n }, (_, i) => `http://seat${i}`);

test('control: each seat\'s answer alone proves the approved set', async () => {
  for (let f = 0; f < FORMS.length; f++) {
    const got = await fetchDonationSet({ round, nodes: nodes(3), verifyEd25519, verifySecp256k1, keys, fetcher: serving(() => f) });
    assert.equal(got.ok, true, `form ${f}: ${got.why}`);
    assert.deepEqual(got.set.recipients.map((r) => r.shareBps), [6000, 3000, 1000]);
  }
});

test('three honest seats, each a valid proof of the same set in its own byte order: the set stands', async () => {
  const got = await fetchDonationSet({ round, nodes: nodes(3), verifyEd25519, verifySecp256k1, keys, fetcher: serving((h) => Number(h.slice(4))) });
  assert.equal(got.ok, true, `three seats serving the same approved set refused every paid join: ${got.why}`);
});

test('seven honest seats split 3/2/2 by approval order: the set stands', async () => {
  const of = (h) => [0, 0, 0, 1, 1, 2, 2][Number(h.slice(4))];
  const got = await fetchDonationSet({ round, nodes: nodes(7), verifyEd25519, verifySecp256k1, keys, fetcher: serving(of) });
  assert.equal(got.ok, true, `seven seats serving the same approved set refused every paid join: ${got.why}`);
});
