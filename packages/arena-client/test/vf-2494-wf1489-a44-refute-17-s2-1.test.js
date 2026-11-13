// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "../../arena-node/node_modules/@noble/curves/secp256k1.js";
import { signedProposal, signedComment, newProposalKey, fetchProposals } from "../src/funding-page.js";
const curve = { pointX: (k) => schnorr.getPublicKey(k), signSchnorr: (m, k) => schnorr.sign(m, k) };
const verify = (sig, msg, pk) => schnorr.verify(sig, msg, pk);
const NET = "1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15";
const nodes = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1:${9100 + i}`);
const fetcherOf = (lists, tip = 156905) => async (url) => { const i = Number(new URL(url).port) - 9100; return { ok: true, json: async () => ({ tip, proposals: lists[i] }) }; };
const mk = (h = 156900, purpose = "Pay me") => { const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: h, amountSats: 5000000, lnurl: "me@x.example", purpose });
  return { p, sk, view: { id: p.id, hex: p.hex, signal: { state: "passed", signalEnd: 157908, supporters: 3, active: 7 }, vote: null, cancelled: null, signals: [], comments: [] } }; };

// kanban #1617 refute (skeptic 2): the stage KEY is now counted by seats, but the vote's and the signal's DETAILS shown beside it
// (YES %, the vote's last block, the signal's end, its supporters) are still the JSON of the first seat in the list that gives that key.
test('the first-listed seat cannot set the shown vote count when six honest seats agree', async () => {
  const { view } = mk();
  const honest = { ...view, vote: { state: 'voting', last: 160000, count: { approvalPct: 12, yesOfAllPct: 3 } } };
  const liar = { ...view, vote: { state: 'voting', last: 160000, count: { approvalPct: 99, yesOfAllPct: 80 } } };
  const lists = [[liar], [honest], [honest], [honest], [honest], [honest], [honest]];
  const r = await fetchProposals({ nodes, fetcher: fetcherOf(lists), verify });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].vote.count.approvalPct, 12, 'shown YES % is one seat\'s: ' + JSON.stringify(r.proposals[0].vote));
});
test('the first-listed seat cannot set the shown signal end or supporters', async () => {
  const { view } = mk();
  const honest = { ...view, signal: { state: 'failed', signalEnd: 157908, supporters: 1, active: 7 } };
  const liar = { ...view, signal: { state: 'failed', signalEnd: 157908, supporters: 0, active: 900 } };
  const lists = [[liar], [honest], [honest], [honest], [honest], [honest], [honest]];
  const r = await fetchProposals({ nodes, fetcher: fetcherOf(lists), verify });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.proposals[0].signal.supporters, r.proposals[0].signal.active], [1, 7], 'shown signal is one seat\'s: ' + JSON.stringify(r.proposals[0].signal));
});
