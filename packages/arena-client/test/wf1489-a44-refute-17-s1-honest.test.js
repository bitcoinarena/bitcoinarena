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

test('honest: seven seats, real verify, decoded fields shown; a forged signature is not shown; uppercase hex from one seat is not counted', async () => {
  const { p, view } = mk();
  let r = await fetchProposals({ nodes, fetcher: fetcherOf(Array(7).fill([view])), verify });
  assert.equal(r.proposals.length, 1); const s = r.proposals[0];
  assert.deepEqual([s.id, s.purpose, s.amountSats, s.lnurl, s.network, s.publishedHeight, s.holding], [p.id, 'Pay me', '5000000', 'me@x.example', NET, 156900, 7]);
  const bad = { ...view, hex: view.hex.slice(0, -2) + (view.hex.slice(-2) === '00' ? '01' : '00') };
  r = await fetchProposals({ nodes, fetcher: fetcherOf(Array(7).fill([bad])), verify });
  assert.equal(r.proposals.length, 0, 'forged signature shown');
  const up = { ...view, hex: view.hex.toUpperCase(), purpose: 'other' };
  r = await fetchProposals({ nodes, fetcher: fetcherOf([[up], [view], [view], [view], [view], [view], [view]]), verify });
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].purpose, 'Pay me'); assert.equal(r.proposals[0].holding, 6);
});
