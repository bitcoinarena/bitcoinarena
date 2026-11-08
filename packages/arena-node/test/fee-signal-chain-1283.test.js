// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1283 (RULED #1277 B): from FEE_SIGNAL_CHAIN_HEIGHT a fee proposal's signal is read from its period's blocks - one per bond, 15 % of the census at
// publication, decided once the last period block is decideDepth deep (never under 3), and a reorg of that block re-decides; the off-chain records count for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeFeeProposal, feeProposalId } from '../../arena-protocol/src/fee-proposal.js';
import { encodeFeeSignal, feeSignalMessage } from '../../arena-protocol/src/fee-signal-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 6; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const S = FUNDING_SCHEDULES.short;                                          // a 1-block signal: the period is block 100
const FP = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, activationHeight: 140, changes: [{ fee: 'roundNodeBps', value: 350 }], purpose: 'chain signal' };
const ID = feeProposalId(FP);
const bond = (n) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: 1000n, height: 50 });

function world() {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10), bond(11), bond(12), bond(13)] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), fee: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null), votesAt: async () => [],
    feeItemsAt: async (h) => at(h).fee.map((x) => ({ ...x, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => chain.tip, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, devKeysOf: async () => [], feeChainFrom: () => 0 });
  return { b, chain, at };
}
const signal = (n) => ({ kind: 'signal', payload: encodeFeeSignal({ proposalId: ID, signature: schnorr.sign(feeSignalMessage(ID), sk(n)) }), txid: 'bb'.repeat(32) });

test('#1283 the signal from the chain: one bond of four (25 %) passes, the off-chain signal counts for nothing, a reorg of the period block re-decides', async () => {
  const w = world();
  assert.equal((await w.b.add('fee', hexOf(encodeFeeProposal(FP), ID, 1))).ok, true);
  // an off-chain signal by the active node: from the chain height it counts for nothing
  const s = { proposalId: ID, node: pk(2), atHeight: 100 };
  assert.equal((await w.b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2))).ok, true);
  w.at(100).fee.push(signal(10));
  w.chain.tip = 101; const early = await w.b.decide();                     // the period's block is 1 deep: not yet
  w.chain.tip = 100 + Math.max(3, S.decideDepth) - 1;
  const [first] = await w.b.decide();
  // a reorg replaces block 100 with one that carries no signal
  w.at(100).hash = 'ff'.repeat(32); w.at(100).fee = [];
  const [again] = await w.b.decide();
  const facts = { early: early.length, first: [first.state, first.supporters, first.active, first.chain], afterReorg: again ? [again.state, again.supporters] : null };
  console.log('  MEASURED #1283 book:', JSON.stringify(facts));
  assert.equal(facts.early, 0);
  assert.deepEqual(facts.first, ['passed', 1, 4, true]);
  assert.deepEqual(facts.afterReorg, ['failed', 0]);
});
