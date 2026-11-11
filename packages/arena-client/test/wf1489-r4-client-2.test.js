// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (client): A FUNDING PROPOSAL IS SHOWN AS ITS SIGNED BYTES SAY, NOT AS ONE SEAT'S JSON SAYS. fetchProposals groups
// the seats' answers by the proposal's signed hex and shows it only when `needed` seats hold that hex - and then takes its id, purpose,
// amount, Lightning address and author from views[0], the JSON beside the hex of the FIRST seat in the list. One seat (the first asked)
// that hands the genuine hex with its own purpose / amountSats / lnurl / id shows every visitor a proposal the authors never signed,
// and a comment signed on that page names the id that seat chose. Safe: the shown fields are the ones the signed hex encodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { signedProposal, newProposalKey, fetchProposals } from '../src/funding-page.js';

const curve = { pointX: (k) => schnorr.getPublicKey(k), signSchnorr: (m, k) => schnorr.sign(m, k) };
const NET = '1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15';

test('one seat cannot rewrite the purpose, amount, Lightning address or id of a proposal five seats hold', async () => {
  const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: 156900, amountSats: 5000000, lnurl: 'attacker@evil.example', purpose: 'Pay me 5M sat for nothing' });
  const honest = { id: p.id, hex: p.hex, purpose: 'Pay me 5M sat for nothing', amountSats: '5000000', lnurl: 'attacker@evil.example', author: 'aa', network: NET,
    publishedHeight: 156900, signal: { state: 'signalling' }, vote: null, signals: [], comments: [] };
  // the first seat asked: the same signed hex, a harmless face
  const liar = { ...honest, id: 'ee'.repeat(32), purpose: 'Run a second relay', amountSats: '21000', lnurl: 'relay@arena.example' };
  const answers = [liar, honest, honest, honest, honest, honest, honest];
  const fetcher = async (url) => { const i = Number(new URL(url).port) - 9100;
    return { ok: true, json: async () => ({ tip: 156905, proposals: [answers[i]] }) }; };
  const nodes = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1:${9100 + i}`);
  const r = await fetchProposals({ nodes, fetcher });
  assert.equal(r.ok, true, r.why);
  const shown = r.proposals[0];
  assert.deepEqual([shown.id, shown.purpose, String(shown.amountSats), shown.lnurl], [p.id, 'Pay me 5M sat for nothing', '5000000', 'attacker@evil.example'],
    `shown as the first seat's JSON says: ${JSON.stringify([shown.id.slice(0, 8), shown.purpose, shown.amountSats, shown.lnurl])}`);
});
