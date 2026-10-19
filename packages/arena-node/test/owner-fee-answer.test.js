// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL DEVELOPER APPROVES OR DENIES A FEE PROPOSAL FROM THE OWNER PAGE (2026-10-17: "The dev ui client
// shows this and the protocol dev may deny or give his approval"), on a running node: the owner's signed request names one of its dev
// clients and a fee proposal; the node signs the answer with that client's own key (BIP340 over the answer's id - its x-only key, the
// key the network donation set names as 02/03 || x), keeps it only for a fee proposal it holds (404 otherwise, as the seat rule of
// slice 2) and GET /fees lists it. Only the owner may ask, and only for a dev client of this node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { encodeFeeProposal, feeProposalId } from '../../arena-protocol/src/fee-proposal.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const sign = (m, s) => schnorr.sign(m, s);
const pubkeyOf = (s) => schnorr.getPublicKey(s);
const memory = () => { const m = { owner: null, code: null }; return { m, store: { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } } }; };
const seedA = new Uint8Array(32).fill(7), seedB = new Uint8Array(32).fill(9);
// a dev key whose compressed point is 03 (odd y): its x-only key is still the x the donation set's 03 || x names
const devSecret = (() => { for (let i = 1; ; i++) { const s = new Uint8Array(32); s[31] = i; s[0] = 0x44; if (secp256k1.getPublicKey(s, true)[0] === 3) return s; } })();
const devPk = secp256k1.getPublicKey(devSecret, true);
const devClients = { keyOf: (slug) => (slug === 'dev-a' ? { recipientPkHex: toHex(devPk), secretHex: toHex(devSecret) } : null),
  list: () => [{ slug: 'dev-a', label: 'dev a', recipientPk: toHex(devPk) }], rowsAndSeats: () => ({ rows: [], seats: [] }) };
const author = new Uint8Array(32).fill(3); author[0] = 0x21;
const P = { networkId: new Uint8Array(32).fill(7), author: schnorr.getPublicKey(author), publishedHeight: 1000, activationHeight: 1000 + 1008 + 2016 + 6 + 50,
  changes: [{ fee: 'roundDonationBps', value: 350 }], purpose: 'less for the developers' };
const PID = toHex(feeProposalId(P));

test('the owner page\'s dev answer: signed with the dev client\'s key, kept for a fee proposal this node holds, listed by GET /fees; refused otherwise', async () => {
  const { m, store } = memory();
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, owner: { store }, devClients });
  try {
    const base = `http://127.0.0.1:${node.port}`;
    const s = await (await fetch(`${base}/owner`)).json();
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const req = (seed, action, args) => signOwnerRequest({ node: s.node, action, args, secret: ownerSecretFromSeed(seed), sign, pubkeyOf });
    assert.equal((await post('/owner/claim', req(seedA, 'claim', { code: m.code }))).status, 200);
    const answer = (args, seed = seedA) => post('/owner/dev/fee-answer', req(seed, 'dev/fee-answer', args));

    // not held yet: refused, as the seat rule
    const early = await answer({ slug: 'dev-a', proposalId: PID, approve: true });
    assert.equal(early.status, 404);
    assert.match((await early.json()).why, /holds no such fee proposal/);

    // the proposal, as the form hands it to every node
    const hex = toHex(Uint8Array.from([...encodeFeeProposal(P), ...schnorr.sign(feeProposalId(P), author)]));
    const kept = await post('/funding', { kind: 'fee', hex });
    assert.equal(kept.status, 200, await kept.clone().text());

    // the owner approves as dev a: signed here, kept
    const ok = await answer({ slug: 'dev-a', proposalId: PID, approve: true });
    assert.equal(ok.status, 200, await ok.clone().text());
    const fees = await (await fetch(`${base}/fees`)).json();
    const p = fees.proposals.find((x) => x.id === PID);
    assert.equal(p.needsDevs, true);
    assert.deepEqual(p.devs, [{ dev: toHex(devPk).slice(2), approve: true }], 'the answer names the dev by the x of its 03 key');
    assert.deepEqual(p.changes, [{ fee: 'roundDonationBps', from: 400, to: 350, donation: true }]);
    // and denies: the newer answer is listed beside it (the decision counts each developer once - funding-book.js devMajority)
    assert.equal((await answer({ slug: 'dev-a', proposalId: PID, approve: false })).status, 200);

    // refused: another key than the owner's, a dev client this node does not run, no proposal id
    assert.equal((await answer({ slug: 'dev-a', proposalId: PID, approve: true }, seedB)).status, 403);
    assert.equal((await answer({ slug: 'dev-z', proposalId: PID, approve: true })).status, 404);
    assert.equal((await answer({ slug: 'dev-a', proposalId: 'nope', approve: true })).status, 400);

    // GET /fees?height= answers the set in force at that height (today's: nothing accepted)
    const at = await (await fetch(`${base}/fees?height=1234`)).json();
    assert.deepEqual([at.height, at.atHeight.roundNodeBps, at.limits.marketDonationBps.min, at.sums.roundMaxBps], [1234, 400, 10, 1000]);
  } finally { await node.close(); }
});
