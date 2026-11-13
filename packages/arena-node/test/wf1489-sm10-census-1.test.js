// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE-MACHINE AUDIT (kanban #1489, round 10, census/proposals): a fee proposal's outcome is decided ONCE, against
// feesAt(activation - 1) as this seat holds it at that moment (funding-book.js decideFees). A proposal B with a far activation
// that is decided BEFORE an earlier-activating proposal A is decided fixes B's whole set on the fees without A. A seat that
// watched the chain live decides B first; a seat that caught up (restart, a backlog of blocks) decides A and B in one pass,
// in activation order, and fixes B on top of A. Same chain, same signed items - two fee sets from B's activation on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeFeeProposal, feeProposalId } from '../../arena-protocol/src/fee-proposal.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 5; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const S = FUNDING_SCHEDULES.short;
const NET = new Uint8Array(32).fill(7);
// B: published first, activates late; A: published later, activates earlier
const B = { networkId: NET, author: pk(1), publishedHeight: 100, activationHeight: 400, changes: [{ fee: 'roundNodeBps', value: 350 }], purpose: 'node fee down' };
const A = { networkId: NET, author: pk(1), publishedHeight: 120, activationHeight: 140, changes: [{ fee: 'marketReserveBps', value: 30 }], purpose: 'market reserve up' };
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const yes = (id, n) => ({ payload: encodeVote({ proposalId: id, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(id, CHOICE.YES), sk(n)) }), txid: 'aa'.repeat(32) });

function chainOf() {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)] };
  chain.at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  for (const [p, h] of [[B, 101], [A, 121]]) chain.at(h).votes.push(yes(feeProposalId(p), 10), yes(feeProposalId(p), 11));
  return chain;
}
const bookOn = (chain) => createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => chain.tip, isBonded: () => true,
  activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }),
  voteChain: { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? chain.at(h).hash : null),
    votesAt: async (h) => chain.at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) },
  devKeysOf: async () => [] });
async function keep(book, p) {
  const id = feeProposalId(p);
  assert.equal((await book.add('fee', hexOf(encodeFeeProposal(p), id, 1))).ok, true);
  const s = { proposalId: id, node: pk(2), atHeight: p.publishedHeight };
  assert.equal((await book.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2))).ok, true);
}
async function step(book) { await book.decide(); await book.voteRound(); return book.decideFees(); }

test('two seats on one chain with the same items fix the same fee set at a later activation, whatever order they decided in', async () => {
  // THE LIVE SEAT: B kept at 100 and decided at 111; A kept at 120 and decided at 131
  const live = chainOf(); const L = bookOn(live);
  await keep(L, B);
  for (const t of [101, 106, 111]) { live.tip = t; await step(L); }
  live.tip = 120; await keep(L, A);
  for (const t of [121, 126, 131]) { live.tip = t; await step(L); }
  // THE SEAT THAT CAUGHT UP: the same items, first counted at 131
  const late = chainOf(); late.tip = 131; const R = bookOn(late);
  await keep(R, B); await keep(R, A);
  await step(R); await step(R);
  const at = (book) => { const f = book.feesAt(400); return { roundNodeBps: f.roundNodeBps, marketReserveBps: f.marketReserveBps }; };
  const decisions = (book) => book.feeList(131).map((x) => ({ act: x.activationHeight, accepted: x.decision && x.decision.accepted }));
  console.log('  MEASURED sm10-census-1:', JSON.stringify({ live: at(L), late: at(R), liveDecisions: decisions(L), lateDecisions: decisions(R) }));
  assert.deepEqual(decisions(L).map((d) => d.accepted), [true, true]);
  assert.deepEqual(decisions(R).map((d) => d.accepted), [true, true]);
  assert.deepEqual(at(L), at(R), 'the live seat and the caught-up seat settle rounds of census height 400 with different fees');
  assert.equal(at(L).marketReserveBps, 30, 'A, accepted and active from 140, is undone at B\'s activation');
});
