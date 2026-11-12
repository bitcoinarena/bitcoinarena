// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 2 (census area), finding 4: the FUNDING VOTE's census (funding-book.js voteRound) is read
// once, at the vote's start height `period.from`, in the first pass after the signal is decided (decideDepth - 1 = 5 blocks past
// it), and stored in funding_vote_census for good. Nothing ties it to the block it was derived from: a reorg of 6 blocks over
// period.from (testnet4 sees them; a bond withdrawn in the replacing branch) leaves this seat counting with the old branch's bonds,
// while a seat that read the census after the reorg counts with the new chain's. The vote blocks heal (walk-back by hash, the
// counted last block's hash reopens a decided vote), the census never does, not even when the outcome reopens.
// Fixtures copied from funding-vote-book.test.js.
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

// ONE CHAIN, TWO SEATS. Branch 1: block 101 keeps bond 11. Branch 2 (a reorg of 101..106): bond 11 is withdrawn in block 101.
const chain = { tip: 100, branch: 1, blocks: new Map() };
const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
const censusOfBranch = () => (chain.branch === 1 ? [bond(10, 3000), bond(11, 7000)] : [bond(10, 3000)]);
const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
  votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => censusOfBranch().map((b) => ({ ...b })) };
const seat = () => createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
  isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });

async function signalled(b) {
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
}

test('wf1489 sm2 census-4: a reorg of the funding vote\'s census block leaves two seats counting with different bonds', async () => {
  const A = seat(), B = seat();
  await signalled(A); await signalled(B);
  chain.tip = 101; await A.decide(); await B.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await A.decide())[0].state, 'passed'); assert.equal((await B.decide())[0].state, 'passed');
  // seat A's first vote pass right after its signal decision: the census at 101 read on branch 1 (6 confirmations)
  await A.voteRound();
  // blocks 101..106 are replaced (a 6-block reorg): bond 11 withdrawn in the new 101. Seat B (restarted, catching up) reads the census only now
  chain.branch = 2; for (let h = 101; h <= 106; h++) chain.blocks.set(h, { hash: `${h}`.padStart(62, '0') + 'ee', votes: [] });
  // the votes, on the chain both seats share: bond 10 NO, bond 11 YES (its vote output still mined; its bond is gone)
  at(102).votes.push(vote(10, CHOICE.NO)); at(103).votes.push(vote(11, CHOICE.YES));
  chain.tip = 107; await B.voteRound(); await A.voteRound();
  chain.tip = 111;
  for (let i = 0; i < 3; i++) { await A.voteRound(); await B.voteRound(); }
  const outcome = (b) => b.list(111).find((x) => x.id === toHex(ID1)).vote;
  const a = outcome(A), bb = outcome(B);
  assert.equal(bb.state, 'failed', 'the seat that read the census on the chain as it is: bond 11 is gone, only the NO counts');
  assert.deepEqual([a.state, a.count.totalSats], [bb.state, bb.count.totalSats],
    'one chain, one census, one outcome: seat A must not keep the census of a block the chain left');
});
