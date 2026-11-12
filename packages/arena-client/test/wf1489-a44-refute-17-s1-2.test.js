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

// kanban #1617 refute: the stage (signal / vote / cancelled) is still one seat's JSON - the most common view by entries, so one seat
// that repeats its view outvotes six honest seats and shows a live proposal as Stopped.
test('one seat cannot set the shown stage of a proposal six honest seats hold', async () => {
  const { view } = mk();
  const liar = { ...view, cancelled: { atHeight: 156901, by: 'author' } };
  const lists = [[liar, liar, liar, liar, liar, liar, liar], [view], [view], [view], [view], [view], [view]];
  const r = await fetchProposals({ nodes, fetcher: fetcherOf(lists), verify });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].cancelled, null, `shown as cancelled by one seat: ${JSON.stringify(r.proposals[0].cancelled)} (holding ${r.proposals[0].holding})`);
});
