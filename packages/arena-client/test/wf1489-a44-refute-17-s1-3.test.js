// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { signedProposal, newProposalKey, fetchProposals } from '../src/funding-page.js';
const curve = { pointX: (k) => schnorr.getPublicKey(k), signSchnorr: (m, k) => schnorr.sign(m, k) };
const verify = (sig, msg, pk) => schnorr.verify(sig, msg, pk);
const NET = '1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15';
const nodes = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1:${9100 + i}`);
const fetcherOf = (lists) => async (url) => { const i = Number(new URL(url).port) - 9100; return { ok: true, json: async () => ({ tip: 156905, proposals: lists[i] }) }; };
const mk = () => { const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: 156900, amountSats: 5000000, lnurl: 'me@x.example', purpose: 'Pay me' });
  return { p, view: { id: p.id, hex: p.hex, purpose: 'Pay me', amountSats: '5000000', lnurl: 'me@x.example', author: 'aa', network: NET, publishedHeight: 156900,
    signal: { state: 'signalling' }, vote: null, cancelled: null, signals: [], comments: [] } }; };

// kanban #1617 refute: comments are still the seats' JSON unchecked - the last seat that names a real comment's id replaces its text
// (and author) for every visitor; the page cannot check it, as no seat hands the comment's signed hex.
test('one seat cannot rewrite a real comment by naming its id', async () => {
  const { view } = mk();
  const real = { id: 'cc'.repeat(32), parent: '00'.repeat(32), author: 'ab'.repeat(32), atHeight: 156901, text: 'I vote no, this is a scam' };
  const honest = { ...view, comments: [real] };
  const liar = { ...view, comments: [{ ...real, text: 'I support this, send the sats' }] };
  const lists = [[honest], [honest], [honest], [honest], [honest], [honest], [liar]];
  const r = await fetchProposals({ nodes, fetcher: fetcherOf(lists), verify });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.proposals[0].comments[0].text, real.text, `shown as the last seat wrote it: ${r.proposals[0].comments[0].text}`);
});

// kanban #2294: seats now hand each comment's signed hex; the page shows what the hex says and checks its signature and proposal
test('a signed comment is shown as its hex says; a rewritten, forged or other-proposal comment is not shown', async () => {
  const { signedComment } = await import('../src/funding-page.js');
  const { p, view } = mk();
  const wsk = newProposalKey(curve), other = mk().p;
  const c = signedComment({ curve, secretKey: wsk, proposalId: p.id, atHeight: 156901, text: 'I vote no, this is a scam' });
  const author = Buffer.from(schnorr.getPublicKey(wsk)).toString('hex');
  const real = { id: c.id, parent: '00'.repeat(32), author, atHeight: 156901, text: 'I vote no, this is a scam', hex: c.hex };
  const liar = { ...real, text: 'I support this, send the sats', author: 'ab'.repeat(32) };   // JSON rewritten beside the real hex
  const forged = signedComment({ curve, secretKey: wsk, proposalId: p.id, atHeight: 156902, text: 'forged' });
  const forgedView = { id: forged.id, parent: '00'.repeat(32), author: 'cd'.repeat(32), atHeight: 156902, text: 'forged', hex: forged.hex.slice(0, -2) + (forged.hex.endsWith('00') ? '01' : '00') };
  const elsewhere = signedComment({ curve, secretKey: wsk, proposalId: other.id, atHeight: 156903, text: 'elsewhere' });
  const lists = [[{ ...view, comments: [real] }], [view], [view], [view], [view], [view],
    [{ ...view, comments: [liar, forgedView, { id: elsewhere.id, parent: '00'.repeat(32), author, atHeight: 156903, text: 'elsewhere', hex: elsewhere.hex }] }]];
  const r = await fetchProposals({ nodes, fetcher: fetcherOf(lists), verify });
  assert.deepEqual(r.proposals[0].comments.map((x) => [x.id, x.author, x.text]), [[c.id, author, 'I vote no, this is a scam']]);
});
