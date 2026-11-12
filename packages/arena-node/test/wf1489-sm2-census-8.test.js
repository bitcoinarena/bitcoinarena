// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 2 (census area), finding 8: A PASSED FUNDING PROPOSAL'S TRANCHE CANCELLED ON A BRANCH THE
// CHAIN LEFT STAYS CANCELLED. funding-book.js payments() re-counts the votes up to each tranche's due block and, when the count fails
// (a NO in the delay), writes the cancellation with stepPayment FIXED -> CANCELLED - "a re-count after a reorg never moves a
// cancellation already kept". But the votes it counted are held to their blocks by hash (#1749/#1750): a reorg that takes the NO's
// block away is followed by voteRound (rows walked back and read again on the new chain), while funding_payments keeps the cancel
// for good. This seat then refuses tranche k and every later one, while a seat that never saw the abandoned branch (restarted on the
// new chain, or joined later) lists them as payable: two seats, one proposal, different payments - the tranche plan never reaches
// its signatures at seats that disagree, or the proposal is paid at some and never at others. Fixtures copied from
// wf1489-sm2-census-1750.test.js (funding-vote-book.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P1 = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, amountSats: 1000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'passes its signal' };
const ID1 = fundingProposalId(P1);
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice) => ({ payload: encodeVote({ proposalId: ID1, choice, signature: schnorr.sign(voteMessage(ID1, choice), sk(n)) }), txid: 'aa'.repeat(32) });


test('wf1489 sm2 census-8: a tranche cancelled by a NO vote whose block is reorged away stays cancelled; a seat on the new chain pays it', async () => {
  const chain = { tip: 100, blocks: new Map() };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h > chain.tip ? null : at(h).hash),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const seat = () => createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  const join = async (b) => { await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1)); await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2)); };
  const A = seat();
  await join(A);
  chain.tip = 101; await A.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await A.decide())[0].state, 'passed');
  // the vote (101-106): both bonds YES - passed
  at(101).votes.push(vote(10, CHOICE.YES)); at(106).votes.push(vote(11, CHOICE.YES));
  chain.tip = 111;
  for (let i = 0; i < 4; i++) await A.voteRound();
  assert.equal(A.list(111).find((x) => x.id === toHex(ID1)).vote.state, 'passed');
  // tranche 0 is due at 112 and payable at 117 (6 deep): bond 11 (7000 of 10000) votes NO in the due block itself - on a branch
  at(112).votes.push(vote(11, CHOICE.NO));
  chain.tip = 117;
  for (let i = 0; i < 3; i++) await A.voteRound();
  assert.deepEqual(A.payments({ tip: 117 }), [], 'on that branch the re-count fails: tranche 0 is cancelled');
  assert.ok(A.cancelledOf(toHex(ID1)), 'the cancellation is written');
  // A 6-BLOCK REORG (112-117 replaced, the depth the payment waited for; testnet4 sees them): the replacing branch carries no NO
  // (the voter's transaction was mined again only after the due block)
  for (let h = 112; h <= 119; h++) chain.blocks.set(h, { hash: `b${h}`.padStart(64, '0'), votes: [] });
  chain.tip = 119;
  for (let i = 0; i < 3; i++) await A.voteRound();
  // a seat that reads only this chain (restarted onto it, or joined after) counts the same proposal
  const B = seat();
  await join(B);
  await B.decide();
  for (let i = 0; i < 4; i++) await B.voteRound();
  assert.equal(B.list(119).find((x) => x.id === toHex(ID1)).vote.state, 'passed');
  const paysB = B.payments({ tip: 119 }).map((p) => p.id);
  assert.equal(paysB.length, 1, 'on this chain tranche 0 is payable');
  const paysA = A.payments({ tip: 119 }).map((p) => p.id);
  assert.deepEqual(paysA, paysB, `the vote blocks followed the reorg, the cancellation did not: seat A refuses tranche 0 for good (${A.cancelledOf(toHex(ID1))}) while seat B pays it`);
});
