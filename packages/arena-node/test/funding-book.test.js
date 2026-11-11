// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FUNDING PROPOSALS A SEAT KEEPS (§27A.9.3 stage 1): a proposal by anyone (2026-10-17), not dated ahead of
// the chain; comments and signals only on a proposal held; a signal only by a bonded node; each signal decided ONCE when its 1008 blocks
// are over, on the nodes active in the 432 blocks before its end - 14 of 100 fails, 15 passes - and not moved by a later reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingComment, fundingCommentId, encodeFundingSignal, fundingSignalId } from '../../arena-protocol/src/funding.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[0] = 1; b[30] = n >> 8; b[31] = n & 255; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const NODES = Array.from({ length: 100 }, (_, i) => i + 1);           // bonded and active: nodes 1..100
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay' };
const proposalHex = (p = P, n = 1) => hexOf(encodeFundingProposal(p), fundingProposalId(p), n);
const signalHex = (n, atHeight = 156850) => { const s = { proposalId: fundingProposalId(P), node: pk(n), atHeight }; return hexOf(encodeFundingSignal(s), fundingSignalId(s), n); };

function book({ tip = 156850, active = NODES } = {}) {
  const state = { tip, active, asked: 0 };
  const b = createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex) || hex === toHex(pk(500)),
    activeAt: async (end) => { state.asked++; return { ok: true, nodes: state.active.map((n) => toHex(pk(n))), fromHeight: end - 432 }; } });
  return { b, state };
}

test('kept: a proposal by anyone - a player as well as a node - then comments by anyone and signals by nodes; refused by name otherwise', async () => {
  const { b } = book();
  assert.match((await b.add('signal', signalHex(2))).why, /holds no such proposal/, 'a signal before its proposal');
  const byPlayer = { ...P, author: pk(900), purpose: 'A player asks for a faucet' };
  const pl = await b.add('proposal', proposalHex(byPlayer, 900));
  assert.deepEqual([pl.ok, pl.fresh], [true, true], 'a proposal by a key that is no bonded node is kept (anyone may propose)');
  assert.match((await b.add('proposal', proposalHex(byPlayer, 901).slice(0, -2) + '00')).why, /signature does not verify/, 'but only signed by its author');
  assert.match((await b.add('proposal', proposalHex({ ...P, publishedHeight: 156852 }))).why, /published at 156852, and this seat's chain is at 156850/);
  const a = await b.add('proposal', proposalHex());
  assert.deepEqual([a.ok, a.fresh], [true, true]);
  assert.equal((await b.add('proposal', proposalHex())).fresh, false, 'handed again: held, not forwarded again');
  const c = { proposalId: fundingProposalId(P), author: pk(4321), atHeight: 156850, text: 'Who runs it?' };
  assert.equal((await b.add('comment', hexOf(encodeFundingComment(c), fundingCommentId(c), 4321))).ok, true, 'a player may comment');
  assert.equal((await b.add('signal', signalHex(2))).ok, true);
  const s9 = { proposalId: fundingProposalId(P), node: pk(901), atHeight: 156850 };
  assert.match((await b.add('signal', hexOf(encodeFundingSignal(s9), fundingSignalId(s9), 901))).why, /given by a bonded node/);
  assert.match((await b.add('signal', signalHex(2).slice(0, -2) + '00')).why, /signature does not verify/);
  assert.match((await b.add('signal', signalHex(3, 156852))).why, /dated 156852, and this seat's chain is at 156850/);
  const listed = b.list(156850).find((x) => x.purpose === 'A second relay');
  assert.deepEqual([listed.amountSats, listed.lnurl, listed.signals.length, listed.comments[0].text, listed.signal.state, listed.signal.signalEnd],
    ['250000', 'dev@bitcoin-arena.io', 1, 'Who runs it?', 'signalling', 157808]);
});

test('decided once the 1008 blocks are over: 14 of 100 active nodes fail, 15 pass; a later reading does not move it', async () => {
  for (const [n, want] of [[14, 'failed'], [15, 'passed']]) {
    const { b, state } = book();
    await b.add('proposal', proposalHex());
    for (let i = 1; i <= n; i++) await b.add('signal', signalHex(i + 1));
    state.tip = 157807;
    assert.deepEqual(await b.decide(), [], 'block 1007: still signalling');
    state.tip = 157808;
    assert.deepEqual(await b.decide(), [], 'the period\'s end: decided once it is decideDepth deep, after the pull (kanban #1279)');
    state.tip = 157808 + 5;
    const [d] = await b.decide();
    assert.deepEqual([d.state, d.supporters, d.active, d.needed, d.activeFrom, d.activeTo], [want, n, 100, 15, 157376, 157808], `${n} signals`);
    state.active = NODES.slice(0, 10);
    assert.deepEqual(await b.decide(), [], 'decided once');
    assert.equal(b.list(157900)[0].signal.state, want);
    assert.equal(state.asked, 1);
  }
});

// KANBAN #1279 (RULED #1277 A, the interim; audit 4 #1257 seats-4): each seat decided a signal at the period's end from its own rows, so one seat posting an
// in-period signal to some seats only, just before the end, made the seats decide differently. Now each decides once the end is decideDepth deep, after
// pulling the others' signals, and counts a signal only when some seat held it before the end.
test('#1279 a signal one seat held just before the end is counted at every seat after the pull; one that arrived after the end at none', async () => {
  const clock = { now: 1_000_000 };
  const state = { tip: 157807 };
  const books = {};
  const make = (name, other) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    pull: async (pid) => books[other].itemsOf(pid) });
  books.A = make('A', 'B'); books.B = make('B', 'A');
  for (const b of [books.A, books.B]) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000;
  await books.B.add('signal', signalHex(16));                         // the 15th, at seat B only, a second before the end
  clock.now += 1_000;
  state.tip = 157808;                                                  // the end: each seat notes when it saw it
  const atEnd = { A: await books.A.decide(), B: await books.B.decide() };
  clock.now += 1_000;
  await books.B.add('signal', signalHex(17));                         // after the end, at seat B only
  state.tip = 157808 + 5;                                              // decideDepth deep (spec schedule: 6)
  const [a] = await books.A.decide(); const [b] = await books.B.decide();
  const facts = { atEnd: [atEnd.A.length, atEnd.B.length], A: [a.state, a.supporters], B: [b.state, b.supporters] };
  console.log('  FACTS #1279:', JSON.stringify(facts));
  assert.deepEqual(facts.atEnd, [0, 0], 'decided at the end, before the pull');
  assert.deepEqual([a.state, a.supporters], ['passed', 15], 'seat A did not count the signal seat B held before the end');
  assert.deepEqual([b.state, b.supporters], ['passed', 15], 'seat B counted a signal that came after the end');
});
