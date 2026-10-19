// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SET ITS DEVELOPERS APPROVED, CHECKED BY THE PAGE ITSELF (§27A.4.1, kanban #382): the nodes serve the admin key's set it
// replaces and the ballots since; the page pays the approved split only when the approvals it was handed make it the set in
// force at the round's height - and refuses a ballot without enough approvals, or with a forged one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { fetchDonationSet } from '../src/donation-pay.js';
import { encodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval, donationApprovalDigest } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

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
const ap = (by, h, signWith = by) => { const a = { proposalId: donationProposalId(P), atHeight: h, accept: true, signer: pk(by) };
  return toHex(encodeDonationApproval(a)) + toHex(secp256k1.sign(donationApprovalDigest(a), sk(signWith))); };
const round = (censusHeight, setId = donationSetId(NEW)) => ({ networkId: NET, donationSetId: setId, censusHeight, gameId: NEXTBLOCK_GAME_ID, id: new Uint8Array(32).fill(9) });
const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
const serving = (body) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
  if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('the approved split is paid once the page counted more than half itself; a round below its height is not', async () => {
  const body = { approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(2, 200), ap(1, 201)] }] };
  const got = await fetchDonationSet({ round: round(202), nodes, verifyEd25519, verifySecp256k1, keys, fetcher: serving(body) });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.set.recipients.map((r) => r.shareBps), [6000, 3000, 1000]);
  assert.equal(got.set.validFrom, 202);
  const early = await fetchDonationSet({ round: round(201), nodes, verifyEd25519, verifySecp256k1, keys, fetcher: serving(body) });
  assert.equal(early.ok, false, 'at 201 the parent is still in force');
});

test('not enough approvals, or a forged one, and the page pays no approved split', async () => {
  const few = await fetchDonationSet({ round: round(300), nodes, verifyEd25519, verifySecp256k1, keys, fetcher: serving({ approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(2, 200)] }] }) });
  assert.equal(few.ok, false); assert.match(few.why, /do not make a set in force/);
  const forged = await fetchDonationSet({ round: round(300), nodes, verifyEd25519, verifySecp256k1, keys, fetcher: serving({ approved: true, root: rootHex, chain: [{ proposal: pHex, approvals: [ap(2, 200), ap(1, 201, 7)] }] }) });
  assert.equal(forged.ok, false);
});
