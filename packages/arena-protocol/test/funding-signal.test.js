// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROJECT FUNDING PROPOSALS AND THEIR SIGNAL (§27A.9.3 stage 1): a proposal signed by its bonded author, comments
// and signals signed by their writers, and the signal's two rules - 15 % of the active nodes, active = served a round in the 432 blocks
// before the signal ends. the owner's edges: a 14 % signal fails and a 15 % one passes; a node last active 433 blocks before the end does
// not count, one active 432 blocks before does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodeFundingProposal, decodeFundingProposal, fundingProposalId, encodeFundingComment, fundingCommentId, encodeFundingSignal, fundingSignalId,
  readSignedFunding, signalOutcome, activeNodesBefore, lnurlStands, FUNDING_SCHEDULES } from '../src/funding.js';
import { signFinalSig } from '../src/final-sig.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 1; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const NET = new Uint8Array(32).fill(7);
const PROPOSAL = { networkId: NET, author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay for the network' };
const signed = (bytes, id, n) => Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]);

test('a proposal, a comment and a signal: their bytes round-trip, each signed by the key it names; a forged one is refused', () => {
  const p = decodeFundingProposal(encodeFundingProposal(PROPOSAL));
  assert.deepEqual([p.amountSats, p.lnurl, p.purpose, p.publishedHeight], [250000n, 'dev@bitcoin-arena.io', 'A second relay for the network', 156800]);
  const pid = fundingProposalId(PROPOSAL);
  const r = readSignedFunding('proposal', signed(encodeFundingProposal(PROPOSAL), pid, 1), verify);
  assert.deepEqual([r.ok, toHex(r.id)], [true, toHex(pid)]);
  assert.match(readSignedFunding('proposal', signed(encodeFundingProposal(PROPOSAL), pid, 2), verify).why, /signature does not verify/, 'signed by another key');
  const c = { proposalId: pid, author: pk(9), atHeight: 156801, text: 'Who runs it?' };
  assert.equal(readSignedFunding('comment', signed(encodeFundingComment(c), fundingCommentId(c), 9), verify).ok, true, 'anyone may comment');
  const s = { proposalId: pid, node: pk(3), atHeight: 156802 };
  assert.equal(readSignedFunding('signal', signed(encodeFundingSignal(s), fundingSignalId(s), 3), verify).ok, true);
  assert.throws(() => encodeFundingProposal({ ...PROPOSAL, lnurl: 'https://x' }), /LNURL or a Lightning address/);
  assert.throws(() => encodeFundingProposal({ ...PROPOSAL, amountSats: 0n }), /at least 1 sat/);
  assert.equal(lnurlStands('LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'), true);
});

// 100 active nodes: 14 supporters is 14 %, 15 is 15 %
const active100 = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(32));
const signalsBy = (n, atHeight = 156900) => active100.slice(0, n).map((node) => ({ node, atHeight }));

test('the 15 % rule: 14 of 100 active nodes fail, 15 pass; nothing is decided before the 1008 blocks are over', () => {
  const end = PROPOSAL.publishedHeight + 1008;
  assert.equal(FUNDING_SCHEDULES.spec.signal, 1008);
  const at14 = signalOutcome({ proposal: PROPOSAL, signals: signalsBy(14), active: active100, tip: end });
  assert.deepEqual([at14.state, at14.supporters, at14.active, at14.pct, at14.needed], ['failed', 14, 100, 14, 15]);
  const at15 = signalOutcome({ proposal: PROPOSAL, signals: signalsBy(15), active: active100, tip: end });
  assert.deepEqual([at15.state, at15.supporters, at15.pct], ['passed', 15, 15]);
  assert.equal(signalOutcome({ proposal: PROPOSAL, signals: signalsBy(100), active: active100, tip: end - 1 }).state, 'signalling', 'block 1007 of 1008');
});

test('what a signal does not count: given before publication or after the end, by a node that is not active, a second one by the same node', () => {
  const end = PROPOSAL.publishedHeight + 1008;
  const s = [...signalsBy(14), { node: active100[14], atHeight: end }, { node: active100[14], atHeight: PROPOSAL.publishedHeight - 1 },
    { node: 'ff'.repeat(32), atHeight: 156900 }, { node: active100[0], atHeight: 156901 }];
  const o = signalOutcome({ proposal: PROPOSAL, signals: s, active: active100, tip: end });
  assert.deepEqual([o.state, o.supporters], ['failed', 14]);
  assert.equal(signalOutcome({ proposal: PROPOSAL, signals: [], active: [], tip: end }).state, 'failed', 'no active node: nothing passes');
  assert.equal(signalOutcome({ proposal: PROPOSAL, signals: signalsBy(1, PROPOSAL.publishedHeight), active: active100.slice(0, 1), tip: PROPOSAL.publishedHeight + 1, schedule: FUNDING_SCHEDULES.short }).state,
    'passed', 'the short schedule of a live proof: 1 block');
});

test('the 432-block window: a node whose last FINAL is 433 blocks before the signal ends is not active; one at 432 is', () => {
  const end = 157808, BASE = 1792000000000;
  const timeOf = (h) => BASE + (h - 150000) * 600000;           // the chain's median time, 10 minutes a block
  const roundId = new Uint8Array(32).fill(0x5a);
  const final = (n, height) => signFinalSig({ roundId, entryId: new Uint8Array(32).fill(1), runId: new Uint8Array(32).fill(2), signerPubkey: pk(n),
    signedAtMs: BigInt(timeOf(height)) }, (d) => schnorr.sign(d, sk(n)));
  const rounds = [{ roundId, committee: [pk(4), pk(5), pk(6)], finals: [final(4, end - 433), final(5, end - 432), final(6, end - 1)] }];
  const a = activeNodesBefore({ rounds, endHeight: end, timeOf, verify, windowBlocks: 432 });
  assert.deepEqual(a.nodes.map((x) => x.key).sort(), [toHex(pk(5)), toHex(pk(6))].sort(), 'node 4 (433 blocks before) is out, node 5 (432) is in');
  assert.deepEqual([a.fromHeight, a.toHeight], [end - 432, end]);
  // and so its signal: node 4 signalled, nodes 5 and 6 did not - none of 2 active supports it
  const sig = signalOutcome({ proposal: { ...PROPOSAL, publishedHeight: end - 1008 }, signals: [{ node: toHex(pk(4)), atHeight: end - 10 }], active: a.nodes.map((x) => x.key), tip: end });
  assert.deepEqual([sig.state, sig.supporters, sig.active], ['failed', 0, 2]);
});
