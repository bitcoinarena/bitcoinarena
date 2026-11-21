// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1633 (audit44 item 14), failure 1: THE SECOND COPY of the per-block vote read - funding-book.js
// voteRound - has the hole #1633 closed in ballot-tally.js. It reads each voting block's hash on its own (hashAt, then
// votesAt), and before deciding checks only the LAST voting block's hash. A reorg landing between two reads of one pass keeps
// the abandoned branch's votes in funding_vote_blocks while the anchor (the new branch's last block) says nothing moved; the
// walk-back at the next pass checks only the newest held row, which is on the chain. Fixtures copied from wf1489-sm2-census-1750.
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

test('wf1489-a44-refute-14-s1-1: a reorg between two block reads of one funding vote pass leaves the abandoned branch\'s votes in the count', async () => {
  const chain = { tip: 100, branch: 0, blocks: new Map(), byHash: new Map() };
  const put = (h, votes) => { const hash = `${String(chain.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); chain.blocks.set(h, hash); chain.byHash.set(hash, votes || []); };
  for (let h = 0; h <= 130; h++) put(h, []);
  const fork = (at, votes) => { chain.branch++; for (let h = at; h <= 130; h++) put(h, votes.get(h)); };
  // BRANCH A: bond 11 (7000 of 10000) votes YES at 102 (the census block 101 stays: its hash check, kanban #1749, does not move)
  put(102, [vote(11, CHOICE.YES)]);
  let forked = false;
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h > chain.tip ? null : chain.blocks.get(h)),
    votesAt: async (h, hash) => {
      // THE CHAIN MOVES WHILE THE PASS READS: just before block 103's votes, blocks 102 up are replaced - on branch B bond 11 votes NO
      if (h === 103 && !forked) { forked = true; fork(102, new Map([[102, [vote(11, CHOICE.NO)]]])); hash = chain.blocks.get(103); }
      return (chain.byHash.get(hash || chain.blocks.get(h)) || []).map((v) => ({ ...v, height: h }));
    },
    censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await b.decide())[0].state, 'passed');
  chain.tip = 111;
  for (let i = 0; i < 4; i++) await b.voteRound();
  assert.ok(forked, 'the fork happened mid-pass');
  chain.tip = 113;
  for (let i = 0; i < 4; i++) await b.voteRound();
  const v = b.list(113).find((x) => x.id === toHex(ID1)).vote;
  console.log('  VOTE:', JSON.stringify({ state: v.state, yesSats: v.count && String(v.count.yesSats), noSats: v.count && String(v.count.noSats) }));
  // THE CHAIN HOLDS bond 11's NO at 102: every seat that read the phase after the reorg counts YES 0, NO 7000 - failed
  assert.equal(v.state, 'failed', `the count must be this chain's (it is ${v.state}, yes ${v.count && v.count.yesSats})`);
});
